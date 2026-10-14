/**
 * Native terminal shared contracts (main ↔ renderer).
 *
 * See docs/technical/native-terminal-design.md for the architecture.
 */

export type TerminalSessionType = 'local' | 'ssh'

export type TerminalSessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export type TerminalSshAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKey: string; passphrase?: string }

export interface TerminalSshSessionConfig {
  type: 'ssh'
  host: string
  port?: number
  username: string
  auth: TerminalSshAuth
  /** Keepalive interval in seconds, default 15. */
  keepaliveIntervalSeconds?: number
}

export interface TerminalLocalSessionConfig {
  type: 'local'
  /** Absolute shell path; defaults to the platform login shell. */
  shell?: string
  cwd?: string
}

export type TerminalSessionConfig = TerminalSshSessionConfig | TerminalLocalSessionConfig

export interface TerminalSessionInfo {
  id: string
  type: TerminalSessionType
  /** Human readable label, e.g. `user@host:port` or the shell basename. */
  title: string
  status: TerminalSessionStatus
  error?: string
  /** sha256 hex fingerprint of the SSH host key (TOFU record). */
  hostKeyFingerprint?: string
  startedAt: number
}

/** One executed command, reported via OSC 4545 shell integration (P0-2). */
export interface TerminalHistoryEntry {
  script: string
  rating: number
  /** Epoch milliseconds of the last execution. */
  completedAt: number
  exitCode?: number
  cwd?: string
  /** Remote host label for SSH sessions, `user@host:port`. */
  host?: string
}

// ---------------------------------------------------------------------------
// Dynamic event channels (main → renderer)
// ---------------------------------------------------------------------------

export const TERMINAL_DATA_CHANNEL_PREFIX = 'terminal:data:'
export const TERMINAL_EXIT_CHANNEL_PREFIX = 'terminal:exit:'
export const TERMINAL_STATUS_CHANNEL_PREFIX = 'terminal:status:'

export const dataChannelFor = (sessionId: string): string => `${TERMINAL_DATA_CHANNEL_PREFIX}${sessionId}`
export const exitChannelFor = (sessionId: string): string => `${TERMINAL_EXIT_CHANNEL_PREFIX}${sessionId}`
export const statusChannelFor = (sessionId: string): string => `${TERMINAL_STATUS_CHANNEL_PREFIX}${sessionId}`

// ---------------------------------------------------------------------------
// Shell integration protocol (P0-1)
// ---------------------------------------------------------------------------

/** Custom OSC identifier used by the Raven shell integration scripts. */
export const OSC_RAVEN_SHELL_INTEGRATION = 4545

export type RavenOscAction =
  | { type: 'cwd'; cwd: string }
  | { type: 'commandStarted'; script: string }
  | { type: 'commandExited'; exitCode: number }
  | { type: 'promptBegins' }
  | { type: 'promptEnds' }

/**
 * Parse the payload delivered by xterm's `registerOscHandler(4545, cb)`.
 * The callback receives everything after `ESC ] 4545 ;`, e.g. `SetCwd;<base64>`.
 * Returns null for unknown/malformed payloads.
 */
export function parseRavenOsc(data: string): RavenOscAction | null {
  const sep = data.indexOf(';')
  const action = sep === -1 ? data : data.slice(0, sep)
  const payload = sep === -1 ? '' : data.slice(sep + 1)
  switch (action) {
    case 'SetCwd': {
      const cwd = decodeBase64Utf8(payload)
      return cwd ? { type: 'cwd', cwd } : null
    }
    case 'CommandStarted': {
      const script = decodeBase64Utf8(payload)
      return script ? { type: 'commandStarted', script } : null
    }
    case 'CommandExited': {
      const exitCode = Number.parseInt(payload, 10)
      return Number.isNaN(exitCode) ? null : { type: 'commandExited', exitCode }
    }
    case 'ShellPromptBegins':
      return { type: 'promptBegins' }
    case 'ShellPromptEnds':
      return { type: 'promptEnds' }
    default:
      return null
  }
}

export function decodeBase64Utf8(value: string): string {
  if (!value) return ''
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

/** bash rejects commands longer than 4095 chars; anything beyond is noise. */
export const MAX_HISTORY_SCRIPT_LENGTH = 4095
