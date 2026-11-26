import fs from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, type ElectronApplication, expect, test } from '@playwright/test'

const model = 'terminal-e2e-model'
const answer = 'echo raven-terminal-ai-ready'
const user = { id: 'terminal-e2e', username: 'terminal-e2e' }

async function startRavenService() {
  const modelRequests: Array<{ model: string; messages: unknown }> = []
  const server = createServer(async (request, response) => {
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`
    const now = Math.floor(Date.now() / 1000)
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', '*')

    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }

    if (request.url === '/v1/messages' && request.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      modelRequests.push(JSON.parse(Buffer.concat(chunks).toString()))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'terminal-e2e-reply',
            type: 'message',
            model,
            role: 'assistant',
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 }
          }
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' }
      ]
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      return
    }

    const payloads: Record<string, unknown> = {
      '/api/v1/users/auth/login': { token: 'terminal-e2e-token', expires_at: now + 3600, user },
      '/api/v1/users/auth/me': { data: user },
      '/api/v1/users/chat-sessions': { data: [] },
      '/api/v1/client-ai/usage': { data: { invocation_id: 'terminal-e2e-reply' } },
      '/api/v1/client-ai/capabilities': {
        data: {
          revision: 'terminal-e2e',
          issued_at: now,
          expires_at: now + 3600,
          refresh_after_seconds: 60,
          routes: [
            {
              slot: 'primary',
              provider: 'anthropic',
              api_protocol: 'anthropic_messages',
              base_url: baseUrl,
              api_key: 'terminal-e2e-model-key',
              model,
              capabilities: {
                image_input: false,
                document_input: false,
                tool_use: true,
                partial_streaming: true,
                thinking_budget: false
              }
            }
          ]
        }
      }
    }
    const payload = payloads[request.url ?? '']
    response.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload ?? {}))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, modelRequests }
}

// Build with `yarn build` first. Set RAVEN_TERMINAL_E2E_EXECUTABLE to Raven.app/Contents/MacOS/Raven
// to exercise the packaged runtime on macOS with the same assertions.
test('macOS Terminal fills the workspace and supports a local shell and streamed AI replies', async () => {
  test.skip(process.platform !== 'darwin', 'The embedded AI terminal is enabled on macOS')
  test.setTimeout(90_000)
  const executablePath = process.env.RAVEN_TERMINAL_E2E_EXECUTABLE
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-terminal-e2e-'))
  const { server, port, modelRequests } = await startRavenService()
  let app: ElectronApplication | undefined

  try {
    app = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
      env: {
        ...process.env,
        RAVEN_AI_SERVICE_HOST: '127.0.0.1',
        RAVEN_AI_SERVICE_PORT: String(port)
      }
    })
    const raven = await app.firstWindow()
    await raven.locator('input[autocomplete="username"]').fill(user.username)
    await raven.locator('input[autocomplete="current-password"]').fill('terminal-e2e-password')
    await raven.locator('input[autocomplete="current-password"]').press('Enter')

    const terminalIcon = raven.locator('#app-sidebar .lucide-square-terminal')
    const guestPromise = app.waitForEvent('window')
    await terminalIcon.click()
    await expect(raven).toHaveURL(/#\/terminal$/)
    const guest = await guestPromise
    await expect(guest).toHaveURL(/^raven-chaterm:\/\/app\/index\.html/)

    const webview = raven.locator('webview')
    const input = guest.getByTestId('ai-message-input')
    const sendButton = guest.getByTestId('send-message-btn')
    await expect(input).toBeVisible()
    await expect(guest.getByText(model, { exact: true })).toBeVisible()

    for (const width of [1440, 1080]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760),
        width
      )
      await expect
        .poll(() =>
          webview.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            const sidebar = document.querySelector('#app-sidebar')!.getBoundingClientRect()
            return {
              startsAfterSidebar: Math.abs(rect.left - sidebar.right) <= 1,
              reachesRightEdge: Math.abs(rect.right - innerWidth) <= 1,
              fillsHeight: Math.abs(rect.bottom - innerHeight) <= 1,
              windowWidth: innerWidth
            }
          })
        )
        .toEqual({ startsAfterSidebar: true, reachesRightEdge: true, fillsHeight: true, windowWidth: width })
      await expect(input).toBeInViewport({ ratio: 1 })
      await expect(sendButton).toBeInViewport({ ratio: 1 })
    }

    const localShell = guest.getByText(/Shell \(Default\)/)
    if (!(await localShell.isVisible())) {
      await guest
        .locator('.title-with-icon')
        .getByText(/本地连接|本地主機|Localhost/)
        .click()
    }
    await localShell.dblclick()
    const terminal = guest.locator('.xterm')
    await expect(terminal).toBeVisible()
    await terminal.click()
    const shellOutput = path.join(profile, 'local-shell-output')
    await guest.keyboard.type(`uname -s | tee '${shellOutput}'`)
    await guest.keyboard.press('Enter')
    await expect
      .poll(() => (fs.existsSync(shellOutput) ? fs.readFileSync(shellOutput, 'utf8').trim() : ''))
      .toBe('Darwin')

    await guest.getByTestId('ai-mode-select').click()
    await guest.getByText('Command', { exact: true }).click()
    await input.fill('Suggest a macOS command that prints a test message.')
    await expect(sendButton).toBeInViewport({ ratio: 1 })
    await sendButton.click()
    const reply = guest.getByTestId('ai-message').getByText(answer, { exact: true }).filter({ visible: true }).first()
    await expect(reply).toBeVisible()
    expect(modelRequests).toContainEqual(
      expect.objectContaining({
        model,
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('Suggest a macOS command') })
        ])
      })
    )

    await raven.locator('#app-sidebar .lucide-message-square').click()
    await expect(webview).toBeHidden()
    await terminalIcon.click()
    await expect(webview).toBeVisible()
    await expect(terminal).toBeVisible()
    await expect(reply).toBeVisible()
    await raven.screenshot({ path: test.info().outputPath('macos-terminal-ai.png') })
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
