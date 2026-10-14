import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Restore real node builtins (the global main setup stubs them).
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))
vi.mock('node:path', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))

import { buildRemoteBootstrap, detectIntegrationShell, installShellIntegrationScripts } from '../shellIntegration'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'raven-shell-integration-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('installShellIntegrationScripts', () => {
  it('writes bash/zsh/fish/sh scripts under userData', () => {
    const paths = installShellIntegrationScripts(tmpDir)
    expect(existsSync(paths.bashrc)).toBe(true)
    expect(existsSync(paths.shrc)).toBe(true)
    expect(existsSync(path.join(paths.zdotdir, '.zshrc'))).toBe(true)
    expect(existsSync(path.join(paths.fishVendorConf, 'raven.fish'))).toBe(true)

    const bashrc = readFileSync(paths.bashrc, 'utf-8')
    // Re-injection guard
    expect(bashrc).toContain('_raven_integration_installed')
    // Sources the user's own ~/.bashrc
    expect(bashrc).toContain('.bashrc')
    // OSC 4545 protocol messages
    expect(bashrc).toContain('4545;CommandStarted')
    expect(bashrc).toContain('4545;CommandExited')
    expect(bashrc).toContain('SetCwd')

    const zshrc = readFileSync(path.join(paths.zdotdir, '.zshrc'), 'utf-8')
    expect(zshrc).toContain('preexec')
    expect(zshrc).toContain('precmd')
    expect(zshrc).toContain('RAVEN_ORIGINAL_ZDOTDIR')
  })

  it('is idempotent', () => {
    installShellIntegrationScripts(tmpDir)
    expect(() => installShellIntegrationScripts(tmpDir)).not.toThrow()
  })
})

describe('buildRemoteBootstrap', () => {
  it('produces a single-line eval with base64 payload', () => {
    const line = buildRemoteBootstrap()
    expect(line.startsWith(' ')).toBe(true) // leading space keeps it out of bash history
    expect(line.endsWith('\n')).toBe(true)
    expect(line).toContain('eval "$(printf %s ')
    expect(line).toContain('base64 -d')
    expect(line).toContain('base64 -D') // BSD/macOS fallback
    expect(line.split('\n').length).toBe(2) // single command line + trailing newline
  })

  it('encodes a payload that decodes to bash/zsh hooks', () => {
    const line = buildRemoteBootstrap()
    const encoded = line.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/)
    expect(encoded).not.toBeNull()
    const payload = Buffer.from(encoded![1], 'base64').toString('utf-8')
    expect(payload).toContain('ZSH_VERSION')
    expect(payload).toContain('BASH_VERSION')
    expect(payload).toContain('4545') // OSC identifier in __raven_osc
    expect(payload).toContain('CommandStarted')
    expect(payload).toContain('CommandExited')
    expect(payload).toContain('SetCwd')
  })
})

describe('detectIntegrationShell', () => {
  it('detects bash/zsh/fish by basename', () => {
    expect(detectIntegrationShell('/bin/bash')).toBe('bash')
    expect(detectIntegrationShell('/usr/bin/zsh')).toBe('zsh')
    expect(detectIntegrationShell('/usr/local/bin/fish')).toBe('fish')
    expect(detectIntegrationShell('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
  })

  it('returns null for unsupported shells', () => {
    expect(detectIntegrationShell('/bin/sh')).toBeNull()
    expect(detectIntegrationShell('powershell.exe')).toBeNull()
    expect(detectIntegrationShell('/bin/dash')).toBeNull()
  })
})
