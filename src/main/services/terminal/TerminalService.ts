import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import {
  TerminalHistoryEntry,
  TerminalSessionConfig,
  TerminalSessionInfo,
  TerminalSshSessionConfig
} from '@shared/terminal'
import type { WebContents } from 'electron'
import { ipcMain } from 'electron'
import * as os from 'os'
import * as path from 'path'

import { TerminalHistoryStore } from './historyStore'
import { LocalPtySession } from './LocalPtySession'
import { installShellIntegrationScripts, ShellIntegrationPaths } from './shellIntegration'
import { KnownHostsStore, SshSession } from './SshSession'

const logger = loggerService.withContext('TerminalService')

interface SessionEntry {
  session: LocalPtySession | SshSession
  sender: WebContents
}

function defaultLocalShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'powershell.exe'
  }
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

/**
 * Native terminal backend: owns PTY/SSH sessions, forwards data/status events
 * to the creating renderer, and hosts the command history store (P0-2).
 */
export class TerminalService {
  private sessions = new Map<string, SessionEntry>()
  private history: TerminalHistoryStore | null = null
  private knownHosts: KnownHostsStore | null = null
  private integrationPaths: ShellIntegrationPaths | null = null
  private disposers: Array<() => void> = []
  private sessionSeq = 0

  start(): void {
    const userDataPath = this.userDataPath()
    this.integrationPaths = installShellIntegrationScripts(userDataPath)
    this.history = new TerminalHistoryStore(userDataPath)
    this.knownHosts = new KnownHostsStore(userDataPath)

    this.registerHandler(IpcChannel.Terminal_CreateSession, async (event, config: TerminalSessionConfig) => {
      return this.createSession(config, event.sender)
    })
    this.registerHandler(IpcChannel.Terminal_Write, (event, sessionId: string, data: string) => {
      this.getSession(sessionId, event.sender).write(data)
    })
    this.registerHandler(IpcChannel.Terminal_Resize, (event, sessionId: string, cols: number, rows: number) => {
      this.getSession(sessionId, event.sender).resize(cols, rows)
    })
    this.registerHandler(IpcChannel.Terminal_CloseSession, (event, sessionId: string) => {
      const entry = this.sessions.get(sessionId)
      if (!entry) return
      if (entry.sender.id !== event.sender.id) return
      entry.session.kill()
      this.removeSession(sessionId)
    })
    this.registerHandler(IpcChannel.Terminal_History_Report, (_event, payload: Partial<TerminalHistoryEntry>) => {
      if (!this.history) return
      const entry = this.history.report({
        script: String(payload.script ?? ''),
        exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : undefined,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        host: typeof payload.host === 'string' ? payload.host : undefined
      })
      return entry
    })
    this.registerHandler(IpcChannel.Terminal_History_List, () => {
      return this.history?.list() ?? []
    })
    this.registerHandler(IpcChannel.Terminal_History_Clear, () => {
      this.history?.clear()
    })

    logger.info('TerminalService started')
  }

  stop(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    for (const [id, entry] of this.sessions) {
      try {
        entry.session.kill()
      } catch (error) {
        logger.warn('Failed to kill session on stop', { id, error: String(error) })
      }
    }
    this.sessions.clear()
    this.history?.dispose()
    this.history = null
    logger.info('TerminalService stopped')
  }

  listSessions(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((entry) => ({ ...entry.session.info }))
  }

  // -------------------------------------------------------------------------

  private createSession(config: TerminalSessionConfig, sender: WebContents): TerminalSessionInfo {
    const id = `term_${Date.now().toString(36)}_${(this.sessionSeq++).toString(36)}`
    const session =
      config.type === 'ssh' ? this.createSshSession(config, sender, id) : this.createLocalSession(config, sender, id)

    this.sessions.set(id, { session, sender })

    session.events.on('exit', () => {
      // Keep closed sessions registered briefly so the renderer can observe
      // the exit event; removal happens on explicit close or sender teardown.
      const cleanupTimer = setTimeout(() => {
        const entry = this.sessions.get(id)
        if (entry && (entry.session.info.status === 'closed' || entry.session.info.status === 'error')) {
          this.removeSession(id)
        }
      }, 60_000)
      cleanupTimer.unref?.()
    })

    const onSenderDestroyed = () => this.removeSession(id)
    if (!sender.isDestroyed()) {
      sender.once('destroyed', onSenderDestroyed)
    }

    session.start()
    return { ...session.info }
  }

  private createSshSession(config: TerminalSshSessionConfig, sender: WebContents, id: string): SshSession {
    if (!this.knownHosts) throw new Error('TerminalService not started')
    return new SshSession(config, this.knownHosts, sender, id)
  }

  private createLocalSession(
    config: Extract<TerminalSessionConfig, { type: 'local' }>,
    sender: WebContents,
    id: string
  ): LocalPtySession {
    if (!this.integrationPaths) throw new Error('TerminalService not started')
    return new LocalPtySession(config, this.integrationPaths, defaultLocalShell(), sender, id)
  }

  private getSession(sessionId: string, sender: WebContents): LocalPtySession | SshSession {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`Unknown terminal session: ${sessionId}`)
    if (entry.sender.id !== sender.id) {
      throw new Error('Terminal session belongs to another window')
    }
    return entry.session
  }

  private removeSession(id: string): void {
    const entry = this.sessions.get(id)
    if (!entry) return
    try {
      entry.session.kill()
    } catch {
      // already gone
    }
    this.sessions.delete(id)
  }

  private registerHandler<T>(
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => T
  ): void {
    ipcMain.handle(channel, handler)
    this.disposers.push(() => ipcMain.removeHandler(channel))
  }

  private userDataPath(): string {
    // Lazily require to keep this service unit-testable outside of Electron.
    try {
      const { app } = require('electron') as typeof import('electron')
      return app.getPath('userData')
    } catch {
      return path.join(os.tmpdir(), 'raven-terminal-test')
    }
  }
}
