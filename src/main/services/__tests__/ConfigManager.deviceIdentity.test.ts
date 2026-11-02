import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ConfigKeys, ConfigManager } from '../ConfigManager'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

const values = vi.hoisted(() => new Map<string, unknown>())
vi.mock('electron-store', () => ({
  default: class {
    get(key: string, fallback?: unknown) {
      return values.get(key) ?? fallback
    }
    set(key: string, value: unknown) {
      values.set(key, value)
    }
  }
}))

let directory: string
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'raven-config-identity-'))
  vi.mocked(app.getPath).mockReturnValue(directory)
  values.clear()
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('migrates on name-first reads, mirrors the scope, and recovers after a version-changing reinstall', () => {
  values.set(ConfigKeys.DeviceLinkDeviceId, 'legacy-0.4.0-abcdef')
  values.set(ConfigKeys.DeviceLinkDeviceName, 'Existing name')
  const manager = new ConfigManager()
  expect(manager.getDeviceLinkDeviceName()).toBe('Existing name')
  expect(values.get(ConfigKeys.DeviceLinkIdentityScope)).toBeTruthy()
  values.clear()
  vi.mocked(app.getVersion).mockReturnValue('2.0.0')
  const reinstalled = new ConfigManager()
  expect(reinstalled.getDeviceLinkDeviceId()).toBe('legacy-0.4.0-abcdef')
  expect(reinstalled.getDeviceLinkDeviceName()).toBe('Existing name')
})

it('retains explicit identity edits after the profile is removed', () => {
  const manager = new ConfigManager()
  manager.setDeviceLinkDeviceId('custom-id')
  manager.setDeviceLinkDeviceName('Custom name')
  values.clear()
  const reinstalled = new ConfigManager()
  expect(reinstalled.getDeviceLinkDeviceId()).toBe('custom-id')
  expect(reinstalled.getDeviceLinkDeviceName()).toBe('Custom name')
})
