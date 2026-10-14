import { loggerService } from '@logger'
import {
  dataChannelFor,
  exitChannelFor,
  statusChannelFor,
  TerminalSessionInfo,
  TerminalSshSessionConfig
} from '@shared/terminal'
import type { WebContents } from 'electron'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'

import { buildRemoteBootstrap } from './shellIntegration'

const logger = loggerService.withContext('SshSession')

/** ssh2 is pure JS; a static import is safe here. */

const { Client } = require('ssh2') as typeof import('ssh2')

const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000
const READY_TIMEOUT_MS = 20_000

/**
 * Trust-On-First-Use host key store: `<userData>/terminal-known-hosts.json`.
 * First connection records the sha256 fingerprint; later connections must match.
 */
export class KnownHostsStore {
  private records: Record<string, string> = {}
  private readonly file: string

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, 'terminal', 'terminal-known-hosts.json')
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
        if (parsed && typeof parsed === 'object') this.records = parsed
      }
    } catch (error) {
      logger.warn('Failed to load known hosts, starting fresh', { error: String(error) })
    }
  }

  get(hostKey: string): string | undefined {
    return this.records[hostKey]
  }

  record(hostKey: string, fingerprint: string): void {
    this.records[hostKey] = fingerprint
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2), 'utf-8')
    } catch (error) {
      logger.error('Failed to persist known hosts', error as Error)
    }
  }
}

export interface SshSessionEvents extends EventEmitter {
  on(event: 'data', listener: (chunk: Buffer) => void): this
  on(event: 'exit', listener: (exitCode: number) => void): this
  on(event: 'status', listener: (status: TerminalSessionInfo['status'], error?: string) => void): this
}

export class SshSession {
  readonly info: TerminalSessionInfo
  readonly events: SshSessionEvents = new EventEmitter() as SshSessionEvents

  private client: import('ssh2').Client | null = null
  private stream: import('ssh2').ClientChannel | null = null
  private readonly sender: WebContents
  private closedByUser = false

  constructor(
    private readonly config: TerminalSshSessionConfig,
    private readonly knownHosts: KnownHostsStore,
    sender: WebContents,
    id: string
  ) {
    this.sender = sender
    const port = config.port ?? 22
    this.info = {
      id,
      type: 'ssh',
      title: `${config.username}@${config.host}:${port}`,
      status: 'connecting',
      startedAt: Date.now()
    }
  }

  start(): void {
    const { host, username, auth } = this.config
    const port = this.config.port ?? 22
    const hostKey = `${host}:${port}`

    const conn = new Client()
    this.client = conn

    conn
      .on('ready', () => {
        logger.info('SSH connection ready', { host: hostKey, username })
        conn.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            this.fail(`Failed to open shell: ${err.message}`)
            return
          }
          this.stream = stream
          this.info.status = 'connected'
          this.emitStatus('connected')

          stream.on('data', (data: Buffer) => {
            this.sendToRenderer(dataChannelFor(this.info.id), data)
            this.events.emit('data', data)
          })
          stream.stderr.on('data', (data: Buffer) => {
            // Surface stderr into the terminal; most shells merge it anyway.
            this.sendToRenderer(dataChannelFor(this.info.id), data)
            this.events.emit('data', data)
          })
          stream.on('close', () => {
            logger.info('SSH shell closed', { host: hostKey })
            this.info.status = 'closed'
            this.stream = null
            this.sendToRenderer(exitChannelFor(this.info.id), 0)
            this.events.emit('exit', 0)
          })

          // P0-1: inject the OSC 4545 integration into the remote shell.
          stream.write(buildRemoteBootstrap())
        })
      })
      .on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        // Fall back to the configured secret for interactive prompts.
        const secret = auth.type === 'password' ? auth.password : (auth.passphrase ?? '')
        finish(prompts.map(() => secret))
      })
      .on('error', (err: Error & { level?: string }) => {
        this.fail(`SSH error${err.level ? ` (${err.level})` : ''}: ${err.message}`)
      })
      .on('close', () => {
        if (!this.closedByUser && this.info.status !== 'error') {
          this.info.status = 'closed'
          this.emitStatus('closed')
          this.sendToRenderer(exitChannelFor(this.info.id), 0)
          this.events.emit('exit', 0)
        }
      })

    const keepaliveIntervalSeconds = this.config.keepaliveIntervalSeconds ?? DEFAULT_KEEPALIVE_INTERVAL_MS / 1000

    conn.connect({
      host,
      port,
      username,
      readyTimeout: READY_TIMEOUT_MS,
      tryKeyboard: true,
      keepaliveInterval: Math.max(1, Math.round(keepaliveIntervalSeconds * 1000)),
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: (hexFingerprint: string) => {
        const recorded = this.knownHosts.get(hostKey)
        this.info.hostKeyFingerprint = hexFingerprint
        if (!recorded) {
          this.knownHosts.record(hostKey, hexFingerprint)
          logger.info('SSH host key recorded (TOFU)', { host: hostKey, fingerprint: hexFingerprint })
          return true
        }
        if (recorded !== hexFingerprint) {
          this.fail(
            `Host key verification failed for ${hostKey}: the server's key changed ` +
              `(recorded ${recorded.slice(0, 16)}…, received ${hexFingerprint.slice(0, 16)}…). ` +
              'If this is expected, remove the entry in terminal-known-hosts.json.'
          )
          conn.end()
          return false
        }
        return true
      },
      ...(auth.type === 'password'
        ? { password: auth.password }
        : { privateKey: auth.privateKey, passphrase: auth.passphrase })
    })
  }

  write(data: string): void {
    this.stream?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.stream?.setWindow(rows, cols, 0, 0)
  }

  kill(): void {
    this.closedByUser = true
    this.info.status = 'closed'
    try {
      this.stream?.end()
      this.client?.end()
    } catch (error) {
      logger.warn('Failed to close ssh client', { sessionId: this.info.id, error: String(error) })
    }
  }

  private fail(message: string): void {
    logger.error('SSH session failed', { sessionId: this.info.id, message })
    this.info.status = 'error'
    this.info.error = message
    this.emitStatus('error', message)
    this.sendToRenderer(exitChannelFor(this.info.id), 1)
    this.events.emit('exit', 1)
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
