import { readFileSync } from 'node:fs'

import { beforeEach, expect, it, vi } from 'vitest'

import { readSystemMachineId } from '../DeviceIdentity'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn()
}))

beforeEach(() => vi.mocked(readFileSync).mockReset())

it('reads and normalizes the Linux system machine-id', () => {
  vi.mocked(readFileSync).mockReturnValue('ABCDEF0123456789ABCDEF0123456789\n')
  expect(readSystemMachineId('linux')).toBe('abcdef0123456789abcdef0123456789')
  expect(readFileSync).toHaveBeenCalledWith('/etc/machine-id', 'utf8')
})

it('uses the dbus ID when the primary machine-id is absent', () => {
  vi.mocked(readFileSync)
    .mockImplementationOnce(() => {
      throw new Error('Missing')
    })
    .mockReturnValueOnce('abcdef0123456789abcdef0123456789')
  expect(readSystemMachineId('linux')).toBe('abcdef0123456789abcdef0123456789')
  expect(readFileSync).toHaveBeenLastCalledWith('/var/lib/dbus/machine-id', 'utf8')
})

it('rejects unset and malformed Linux machine IDs', () => {
  vi.mocked(readFileSync).mockReturnValueOnce('00000000000000000000000000000000').mockReturnValueOnce('uninitialized')
  expect(readSystemMachineId('linux')).toBeUndefined()
})
