import { loggerService } from '@logger'
import { MAX_HISTORY_SCRIPT_LENGTH, TerminalHistoryEntry } from '@shared/terminal'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import * as path from 'path'

const logger = loggerService.withContext('TerminalHistoryStore')

const DEFAULT_MAX_ENTRIES = 1000
const FLUSH_DEBOUNCE_MS = 2000

/**
 * Persisted command history with exit codes and usage ratings (P0-2).
 *
 * Entries are keyed by exact script text: re-running a command bumps its
 * rating and refreshes completedAt/exitCode/cwd. The store is flushed to
 * `<userData>/terminal-history.json` with a debounce and on dispose.
 */
export class TerminalHistoryStore {
  private entries: TerminalHistoryEntry[] = []
  private readonly file: string
  private readonly maxEntries: number
  private flushTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(userDataPath: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    const dir = path.join(userDataPath, 'terminal')
    mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'terminal-history.json')
    this.maxEntries = maxEntries
    this.load()
  }

  /** Record one executed command (dedup by exact script text). */
  report(input: {
    script: string
    exitCode?: number
    cwd?: string
    host?: string
    completedAt?: number
  }): TerminalHistoryEntry | null {
    if (this.disposed) return null
    const script = input.script.trim()
    if (!script || script.length > MAX_HISTORY_SCRIPT_LENGTH) return null

    const completedAt = input.completedAt ?? Date.now()
    const existing = this.entries.find((e) => e.script === script)
    if (existing) {
      existing.rating += 1
      existing.completedAt = completedAt
      existing.exitCode = input.exitCode
      existing.cwd = input.cwd ?? existing.cwd
      existing.host = input.host ?? existing.host
      this.scheduleFlush()
      return existing
    }

    const entry: TerminalHistoryEntry = {
      script,
      rating: 1,
      completedAt,
      exitCode: input.exitCode,
      cwd: input.cwd,
      host: input.host
    }
    this.entries.push(entry)
    this.evictIfNeeded()
    this.scheduleFlush()
    return entry
  }

  /** Entries sorted by recency (descending). */
  list(): TerminalHistoryEntry[] {
    return [...this.entries].sort((a, b) => b.completedAt - a.completedAt)
  }

  clear(): void {
    this.entries = []
    this.scheduleFlush()
  }

  /** Flush pending writes and stop timers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }

  // -------------------------------------------------------------------------

  private evictIfNeeded(): void {
    if (this.entries.length <= this.maxEntries) return
    // Evict lowest rating, oldest first among equals.
    this.entries.sort((a, b) => a.rating - b.rating || a.completedAt - b.completedAt)
    const excess = this.entries.length - this.maxEntries
    this.entries.splice(0, excess)
    // Restore recency order for stable list() output.
    this.entries.sort((a, b) => a.completedAt - b.completedAt)
  }

  private scheduleFlush(): void {
    if (this.disposed || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_DEBOUNCE_MS)
    // Do not hold the process open for a debounced write.
    this.flushTimer.unref?.()
  }

  private flush(): void {
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.entries), 'utf-8')
      renameSync(tmp, this.file)
    } catch (error) {
      logger.error('Failed to flush terminal history', error as Error)
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as TerminalHistoryEntry[]
      if (!Array.isArray(raw)) return
      this.entries = raw
        .filter(
          (e): e is TerminalHistoryEntry =>
            !!e && typeof e.script === 'string' && e.script.length > 0 && e.script.length <= MAX_HISTORY_SCRIPT_LENGTH
        )
        .map((e) => ({
          script: e.script,
          rating: typeof e.rating === 'number' && e.rating > 0 ? e.rating : 1,
          completedAt: typeof e.completedAt === 'number' ? e.completedAt : Date.now(),
          exitCode: typeof e.exitCode === 'number' ? e.exitCode : undefined,
          cwd: typeof e.cwd === 'string' ? e.cwd : undefined,
          host: typeof e.host === 'string' ? e.host : undefined
        }))
    } catch (error) {
      logger.warn('Failed to load terminal history, starting fresh', { error: String(error) })
      this.entries = []
    }
  }
}
