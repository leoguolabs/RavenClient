import { loggerService } from '@logger'
import {
  dataChannelFor,
  exitChannelFor,
  statusChannelFor,
  TerminalLocalSessionConfig,
  TerminalSessionInfo
} from '@shared/terminal'
import type { WebContents } from 'electron'
import { EventEmitter } from 'events'
import * as path from 'path'

import { detectIntegrationShell, ShellIntegrationPaths } from './shellIntegration'

const logger = loggerService.withContext('LocalPtySession')

/**
 * Minimal structural type for the node-pty module. We require it lazily so a
 * missing/broken native build degrades gracefully (local shell disabled, SSH
 * unaffected) instead of crashing the main process.
 */
interface IPty {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
  readonly pid: number
}

type NodePtyModule = {
  spawn(file: string, args: string[], options: Record<string, unknown>): IPty
}

export interface LocalSessionEvents extends EventEmitter {
  on(event: 'data', listener: (chunk: Buffer) => void): this
  on(event: 'exit', listener: (exitCode: number) => void): this
  on(event: 'status', listener: (status: TerminalSessionInfo['status'], error?: string) => void): this
}

export class LocalPtySession {
  readonly info: TerminalSessionInfo
  readonly events: LocalSessionEvents = new EventEmitter() as LocalSessionEvents

  private pty: IPty | null = null
  private readonly sender: WebContents

  constructor(
    private readonly config: TerminalLocalSessionConfig,
    private readonly integrationPaths: ShellIntegrationPaths,
    private readonly defaultShell: string,
    sender: WebContents,
    id: string
  ) {
    this.sender = sender
    const shell = config.shell || defaultShell
    this.info = {
      id,
      type: 'local',
      title: shellBasename(shell),
      status: 'connecting',
      startedAt: Date.now()
    }
  }

  start(): void {
    let nodePty: NodePtyModule
    try {
      nodePty = require('node-pty') as NodePtyModule
    } catch (error) {
      const message = `node-pty is unavailable (native build missing?): ${String(error)}`
      logger.error(message)
      this.info.status = 'error'
      this.info.error = message
      this.emitStatus('error', message)
      this.events.emit('exit', 1)
      return
    }

    const shell = this.config.shell || this.defaultShell
    const { args, env } = buildSpawnEnvironment(shell, this.integrationPaths)

    try {
      const pty = nodePty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.config.cwd || undefined,
        env: { ...process.env, ...env } as Record<string, string>
      })
      this.pty = pty
      this.info.status = 'connected'
      this.emitStatus('connected')

      pty.onData((data) => {
        const chunk = Buffer.from(data, 'utf-8')
        this.sendToRenderer(dataChannelFor(this.info.id), chunk)
        this.events.emit('data', chunk)
      })
      pty.onExit(({ exitCode }) => {
        this.info.status = 'closed'
        this.pty = null
        this.sendToRenderer(exitChannelFor(this.info.id), exitCode)
        this.events.emit('exit', exitCode)
      })
    } catch (error) {
      const message = `Failed to spawn local shell "${shell}": ${String(error)}`
      logger.error(message)
      this.info.status = 'error'
      this.info.error = message
      this.emitStatus('error', message)
      this.events.emit('exit', 1)
    }
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.pty?.resize(cols, rows)
  }

  kill(): void {
    try {
      this.pty?.kill()
    } catch (error) {
      logger.warn('Failed to kill pty', { sessionId: this.info.id, error: String(error) })
    }
    this.info.status = 'closed'
  }

  private emitStatus(status: TerminalSessionInfo['status'], error?: string): void {
    this.events.emit('status', status, error)
    this.sendToRenderer(statusChannelFor(this.info.id), { ...this.info })
  }

  private sendToRenderer(channel: string, payload: unknown): void {
    if (!this.sender.isDestroyed()) {
      this.sender.send(channel, payload)
    }
  }
}

/** Build shell args + env for shell-integration injection (macOS/Linux). */
export function buildSpawnEnvironment(
  shellPath: string,
  paths: ShellIntegrationPaths
): { args: string[]; env: Record<string, string> } {
  const kind = detectIntegrationShell(shellPath)
  const env: Record<string, string> = {}

  switch (kind) {
    case 'bash':
      // --rcfile only applies to interactive non-login shells; our bashrc
      // sources the user's ~/.bashrc (or simulates -l via RAVEN_SIMULATE_SHELL_LOGIN).
      return { args: ['--rcfile', paths.bashrc], env }
    case 'zsh':
      env.ZDOTDIR = paths.zdotdir
      env.RAVEN_ORIGINAL_ZDOTDIR = process.env.ZDOTDIR || process.env.HOME || ''
      return { args: [], env }
    case 'fish': {
      const xdgData = path.dirname(path.dirname(paths.fishVendorConf)) // .../xdg_data
      env.XDG_DATA_DIRS = xdgData + (process.env.XDG_DATA_DIRS ? path.delimiter + process.env.XDG_DATA_DIRS : '')
      return { args: [], env }
    }
    default:
      // Windows shells / unknown shells: no injection (graceful degradation).
      return { args: [], env }
  }
}

function shellBasename(shellPath: string): string {
  const base = shellPath.split(/[\\/]/).pop() || shellPath
  return base.replace(/\.exe$/i, '')
}
