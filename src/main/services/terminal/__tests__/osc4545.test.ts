import { parseRavenOsc } from '@shared/terminal'
import { describe, expect, it } from 'vitest'

const b64 = (value: string): string => Buffer.from(value, 'utf-8').toString('base64')

describe('parseRavenOsc', () => {
  it('parses SetCwd with base64 UTF-8 payload', () => {
    expect(parseRavenOsc(`SetCwd;${b64('/home/user/目录')}`)).toEqual({ type: 'cwd', cwd: '/home/user/目录' })
  })

  it('parses CommandStarted with base64 command', () => {
    expect(parseRavenOsc(`CommandStarted;${b64('ls -la')}`)).toEqual({ type: 'commandStarted', script: 'ls -la' })
  })

  it('parses CommandExited with decimal exit code', () => {
    expect(parseRavenOsc('CommandExited;0')).toEqual({ type: 'commandExited', exitCode: 0 })
    expect(parseRavenOsc('CommandExited;127')).toEqual({ type: 'commandExited', exitCode: 127 })
  })

  it('parses prompt boundary markers without payload', () => {
    expect(parseRavenOsc('ShellPromptBegins')).toEqual({ type: 'promptBegins' })
    expect(parseRavenOsc('ShellPromptEnds')).toEqual({ type: 'promptEnds' })
  })

  it('returns null for unknown actions and malformed payloads', () => {
    expect(parseRavenOsc('Unknown;xyz')).toBeNull()
    expect(parseRavenOsc('SetCwd;!!!not-base64!!!')).toBeNull()
    expect(parseRavenOsc('CommandExited;NaN')).toBeNull()
    expect(parseRavenOsc('CommandStarted;')).toBeNull()
  })
})
