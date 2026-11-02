import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DeviceIdentity, readSystemMachineId } from '../DeviceIdentity'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

let directory: string
const context = { platform: 'darwin', machineId: 'machine-one', user: '501' }
const resolver = (overrides = {}) => new DeviceIdentity(directory, { ...context, ...overrides })

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'raven-identity-unit-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('reinstall-safe identity', () => {
  it('recovers a deterministic ID with all application and identity files deleted', () => {
    const original = resolver().resolve({})
    rmSync(directory, { recursive: true })
    expect(resolver().resolve({}).deviceId).toBe(original.deviceId)
    expect(original.deviceId).toMatch(/^raven-[a-f0-9]{64}$/)
    expect(original.deviceId).not.toContain(context.machineId)
  })

  it('migrates a legacy ID and name and recovers them with empty userData', () => {
    const original = resolver().resolve({ deviceId: 'old-host-0.4.0-abcdef', deviceName: 'My workstation' })
    expect(resolver().resolve({})).toEqual(original)
    expect(original.deviceId).toBe('old-host-0.4.0-abcdef')
  })

  it('keeps explicit ID/name edits over a stale restored profile', () => {
    const identity = resolver().resolve({ deviceId: 'old-id' })
    resolver().save({ ...identity, deviceId: 'manual-id', deviceName: 'Custom name' })
    expect(resolver().resolve({ deviceId: 'old-id', scope: identity.scope })).toMatchObject({
      deviceId: 'manual-id',
      deviceName: 'Custom name'
    })
  })

  it.each([{ machineId: 'machine-two' }, { user: '502' }, { platform: 'win32' }])(
    'ignores a copied bound profile and identity record on scope change %j',
    (differentScope) => {
      const original = resolver().resolve({})
      expect(resolver(differentScope).resolve(original).deviceId).not.toBe(original.deviceId)
    }
  )

  it('retains identity and name when the hostname changes', () => {
    const original = resolver().resolve({})
    vi.spyOn(os, 'hostname').mockReturnValue('renamed-machine')
    expect(resolver().resolve({})).toEqual(original)
  })

  it('persists a random fallback and keeps it when machine identification recovers', () => {
    const original = resolver({ machineId: undefined }).resolve({})
    expect(resolver({ machineId: undefined }).resolve({})).toEqual(original)
    expect(resolver().resolve({}).deviceId).toBe(original.deviceId)
    expect(resolver().resolve({}).scope).not.toBe(original.scope)
  })

  it('reuses the durable identity during a temporary machine-identification failure', () => {
    const original = resolver().resolve({ deviceId: 'legacy-id' })
    expect(resolver({ machineId: undefined }).resolve({})).toEqual(original)
  })

  it('recovers from a corrupt durable file using matching bound settings', () => {
    const original = resolver().resolve({ deviceId: 'legacy-id' })
    writeFileSync(path.join(directory, 'identity-v1.json'), '{broken')
    expect(resolver().resolve(original)).toEqual(original)
  })

  it('preserves a fallback profile when its durable record is missing', () => {
    const original = resolver({ machineId: undefined }).resolve({})
    rmSync(directory, { recursive: true })
    expect(resolver({ machineId: undefined }).resolve(original)).toEqual(original)
  })

  it('still derives the same new ID when identity storage is unwritable', () => {
    const file = path.join(directory, 'not-a-directory')
    writeFileSync(file, '')
    const first = new DeviceIdentity(file, context).resolve({})
    expect(new DeviceIdentity(file, context).resolve({}).deviceId).toBe(first.deviceId)
  })

  it('persists only hashed scope and public identity fields', () => {
    resolver().resolve({})
    const stored = readFileSync(path.join(directory, 'identity-v1.json'), 'utf8')
    expect(stored).not.toContain(context.machineId)
    expect(JSON.parse(stored).version).toBe(1)
  })

  it('distinguishes accounts with the same Windows username and different user profiles', () => {
    vi.mocked(execFileSync).mockReturnValue('"IOPlatformUUID" = "ABCD-1234"')
    const user = { ...os.userInfo(), uid: -1, username: 'alex', homedir: 'C:\\Users\\alex' }
    vi.spyOn(os, 'userInfo').mockReturnValue(user)
    const first = new DeviceIdentity(path.join(directory, 'first')).resolve({})
    vi.mocked(os.userInfo).mockReturnValue({ ...user, homedir: 'C:\\Users\\alex.DOMAIN' })
    const second = new DeviceIdentity(path.join(directory, 'second')).resolve({})
    expect(first.deviceId).not.toBe(second.deviceId)
  })
})

describe('OS machine identifiers', () => {
  it('parses macOS ioreg with a bounded non-shell call', () => {
    vi.mocked(execFileSync).mockReturnValue('"IOPlatformUUID" = "ABCD-1234"')
    expect(readSystemMachineId('darwin')).toBe('abcd-1234')
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/sbin/ioreg',
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 })
    )
  })

  it('reads Windows MachineGuid from the 64-bit registry', () => {
    vi.mocked(execFileSync).mockReturnValue('    MachineGuid    REG_SZ    ABCD-5678\r\n')
    expect(readSystemMachineId('win32')).toBe('abcd-5678')
    expect(execFileSync).toHaveBeenCalledWith(
      expect.stringContaining('reg.exe'),
      expect.arrayContaining(['/reg:64']),
      expect.any(Object)
    )
  })

  it('falls back cleanly when a machine identifier cannot be read', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('Unavailable')
    })
    expect(readSystemMachineId('darwin')).toBeUndefined()
    expect(readSystemMachineId('freebsd')).toBeUndefined()
  })
})
