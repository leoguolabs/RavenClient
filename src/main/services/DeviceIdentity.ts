import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'

const logger = loggerService.withContext('DeviceIdentity')

export interface DeviceIdentityRecord {
  version: 1
  scope: string
  deviceId: string
  deviceName: string
}

export interface ProfileDeviceIdentity {
  scope?: string
  deviceId?: string
  deviceName?: string
}

// Never log or transmit these raw OS identifiers. No shell, network interfaces or hostname fallbacks.
export function readSystemMachineId(platform: NodeJS.Platform = process.platform): string | undefined {
  const run = (file: string, args: string[]) =>
    execFileSync(file, args, { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 1024 * 1024 })
  try {
    if (platform === 'darwin') {
      return run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
        .match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]
        .trim()
        .toLowerCase()
    }
    if (platform === 'win32') {
      const registry = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
      return run(registry, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'])
        .match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1]
        .trim()
        .toLowerCase()
    }
    if (platform === 'linux') {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const value = readFileSync(file, 'utf8').trim().toLowerCase()
          if (/^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value)) return value
        } catch {
          // Try the next standard machine-id location.
        }
      }
    }
  } catch {
    // Sandboxed/unsupported systems use the independently persisted identity below.
  }
  return undefined
}

function currentUserScope(): string {
  const user = os.userInfo()
  // Windows reports uid=-1; domain and local accounts can share a username but have distinct profiles.
  return user.uid >= 0 ? String(user.uid) : JSON.stringify([user.username.toLowerCase(), user.homedir.toLowerCase()])
}

export class DeviceIdentity {
  private readonly file: string
  private readonly scope?: string

  constructor(
    directory: string,
    context: { platform: string; machineId?: string; user: string } = {
      platform: process.platform,
      machineId: readSystemMachineId(),
      user: currentUserScope()
    }
  ) {
    this.file = path.join(directory, 'identity-v1.json')
    this.scope = context.machineId
      ? createHash('sha256')
          .update(JSON.stringify(['raven-device-v1', context.platform, context.machineId, context.user]))
          .digest('hex')
      : undefined
  }

  resolve(profile: ProfileDeviceIdentity): DeviceIdentityRecord {
    const saved = this.read()
    if (saved && (!this.scope || saved.scope === this.scope || saved.scope.startsWith('fallback-'))) {
      const identity = { ...saved, scope: this.scope || saved.scope }
      if (identity.scope !== saved.scope) this.save(identity)
      return identity
    }

    const scope = this.scope || profile.scope || `fallback-${randomUUID()}`
    // An unbound legacy profile is adopted only on first migration. Bound/copied settings cannot override this machine.
    const canMigrate = profile.scope === scope || (!profile.scope && !saved)
    const identity: DeviceIdentityRecord = {
      version: 1,
      scope,
      deviceId:
        (canMigrate && profile.deviceId?.trim()) || (this.scope ? `raven-${this.scope}` : `raven-${randomUUID()}`),
      deviceName: (canMigrate && profile.deviceName?.trim()) || os.hostname() || 'Raven'
    }
    this.save(identity)
    return identity
  }

  save(identity: DeviceIdentityRecord): void {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify(identity), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } catch {
      logger.warn(
        'Could not persist device identity; legacy/custom/fallback identity recovery requires the original settings'
      )
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        // Atomic rename already removed it, or no temporary file was created.
      }
    }
  }

  private read(): DeviceIdentityRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8'))
      if (
        value.version === 1 &&
        typeof value.scope === 'string' &&
        value.scope.trim() &&
        typeof value.deviceId === 'string' &&
        value.deviceId.trim() &&
        typeof value.deviceName === 'string' &&
        value.deviceName.trim()
      )
        return value
    } catch {
      // Missing or corrupt records can be recovered from bound settings or the deterministic system identity.
    }
    return undefined
  }
}
