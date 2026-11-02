import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'

// Start RavenAIService/tests/e2e/device_link_app.py on a disposable local port first.
// RAVEN_IDENTITY_E2E_URL=http://127.0.0.1:18885 yarn playwright test device-identity.spec.ts --workers=1
const baseUrl = process.env.RAVEN_IDENTITY_E2E_URL
test.skip(!baseUrl, 'Requires the isolated local device-link E2E server')
test.describe.configure({ mode: 'serial' })

test('real Electron identity survives wiped userData, preserves legacy IDs and routes prompts after reconnect', async () => {
  test.setTimeout(120_000)
  const server = new URL(baseUrl!)
  expect(['127.0.0.1', 'localhost']).toContain(server.hostname)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-identity-e2e-'))
  const appData = path.join(root, 'os-app-data')
  const userData = path.join(root, 'user-data')
  const bootstrap = path.join(root, 'bootstrap.cjs')
  fs.mkdirSync(appData, { recursive: true })
  fs.writeFileSync(
    bootstrap,
    `
    const { app } = require('electron')
    app.setName('raven')
    app.setAppPath(${JSON.stringify(process.cwd())})
    app.setPath('appData', ${JSON.stringify(appData)})
    app.setPath('userData', ${JSON.stringify(userData)})
    require(${JSON.stringify(path.join(process.cwd(), 'out/main/index.js'))})
  `
  )

  let instance: ElectronApplication | undefined
  const ownedIds = new Set<string>()
  const devices = async () => (await (await fetch(`${baseUrl}/api/v1/device-links`)).json()).devices as any[]
  const launch = async () => {
    fs.mkdirSync(userData, { recursive: true })
    instance = await electron.launch({
      args: [bootstrap],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        RAVEN_AI_SERVICE_HOST: server.hostname,
        RAVEN_AI_SERVICE_PORT: server.port,
        RAVEN_AI_SERVICE_BASE_URL: baseUrl!
      },
      timeout: 30_000
    })
    const window = await instance.firstWindow()
    await window.waitForFunction(() => Boolean(window.api?.deviceLink))
    const identity = await window.evaluate(() => window.api.deviceLink.getIdentity())
    ownedIds.add(identity.deviceId)
    await expect
      .poll(async () => (await devices()).filter((d) => d.id === identity.deviceId && d.status === 'online').length)
      .toBe(1)
    return { window, identity }
  }
  const close = async () => {
    await instance?.close()
    instance = undefined
  }
  const checkLink = async (window: Page, deviceId: string) => {
    await window.evaluate(async () => {
      // Deterministic IPC responder exercises transport and routing without an external LLM call.
      window.api.deviceLink.onPrompt((message) => {
        void window.api.deviceLink.sendPromptResult({
          type: 'prompt_result',
          request_id: message.request_id,
          session_id: message.session_id,
          topic_id: 'identity-e2e-topic',
          answer: `identity-e2e:${message.prompt}`
        })
      })
      await window.api.deviceLink.updateCapabilities({ identity_e2e: { reinstalled: true } })
    })
    await expect
      .poll(async () => (await devices()).find((d) => d.id === deviceId)?.capabilities?.identity_e2e?.reinstalled)
      .toBe(true)
    const ping = await fetch(`${baseUrl}/api/v1/device-links/${encodeURIComponent(deviceId)}/ping`)
    expect(ping.ok).toBe(true)
    const result = await fetch(`${baseUrl}/_test/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: crypto.randomUUID(),
        session_id: 'identity-e2e',
        target_device_id: deviceId,
        prompt: 'reinstalled'
      })
    })
    expect(result.ok).toBe(true)
    expect((await result.json()).answer).toBe('identity-e2e:reinstalled')
    const before = (await devices()).find((d) => d.id === deviceId).last_seen
    await expect
      .poll(async () => (await devices()).find((d) => d.id === deviceId).last_seen, { timeout: 5000 })
      .not.toBe(before)
  }

  try {
    const first = await launch()
    expect(first.identity.deviceId).toMatch(/^raven-[a-f0-9]{64}$/)
    await close()
    fs.rmSync(userData, { recursive: true, force: true })
    const second = await launch()
    expect(second.identity).toEqual(first.identity)
    expect((await devices()).filter((d) => ownedIds.has(d.id))).toHaveLength(1)
    await checkLink(second.window, second.identity.deviceId)

    // Remove both disposable stores: a fresh install still derives the same OS-scoped ID.
    await close()
    fs.rmSync(userData, { recursive: true, force: true })
    fs.rmSync(path.join(appData, 'RavenAI'), { recursive: true, force: true })
    const third = await launch()
    expect(third.identity.deviceId).toBe(first.identity.deviceId)
    await close()
    await fetch(`${baseUrl}/api/v1/device-links/${encodeURIComponent(first.identity.deviceId)}`, { method: 'DELETE' })

    // Seed the actual electron-store format used by pre-upgrade installations.
    fs.rmSync(userData, { recursive: true, force: true })
    fs.rmSync(path.join(appData, 'RavenAI'), { recursive: true, force: true })
    fs.mkdirSync(userData, { recursive: true })
    const legacyId = `identity-e2e-legacy-0.4.0-${Date.now()}`
    fs.writeFileSync(
      path.join(userData, 'config.json'),
      JSON.stringify({
        deviceLinkDeviceId: legacyId,
        deviceLinkDeviceName: 'Identity E2E workstation'
      })
    )
    const migrated = await launch()
    expect(migrated.identity.deviceId).toBe(legacyId)
    await migrated.window.evaluate(() => window.api.deviceLink.updateIdentity({ deviceName: 'Identity E2E renamed' }))
    await expect.poll(async () => (await devices()).find((d) => d.id === legacyId)?.name).toBe('Identity E2E renamed')
    await close()
    fs.rmSync(userData, { recursive: true, force: true })
    const restored = await launch()
    expect(restored.identity).toEqual({ deviceId: legacyId, deviceName: 'Identity E2E renamed' })
    expect((await devices()).filter((d) => ownedIds.has(d.id))).toHaveLength(1)
    await checkLink(restored.window, legacyId)
    console.log(
      'Verified fresh identity, full data removal, legacy migration, rename, reinstall, capabilities, heartbeat and prompt round trip'
    )
  } finally {
    await close()
    for (const id of ownedIds) {
      await fetch(`${baseUrl}/api/v1/device-links/${encodeURIComponent(id)}`, { method: 'DELETE' })
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
