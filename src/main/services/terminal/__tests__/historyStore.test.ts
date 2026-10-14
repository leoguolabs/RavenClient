import { mkdtempSync, rmSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The global main setup mocks node:fs/node:os/node:path with stubs; these
// tests exercise real filesystem behaviour, so restore the actual modules.
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))
vi.mock('node:path', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))

import { TerminalHistoryStore } from '../historyStore'

let tmpDir: string
let store: TerminalHistoryStore

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'raven-history-'))
  store = new TerminalHistoryStore(tmpDir)
})

afterEach(() => {
  store?.dispose()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('TerminalHistoryStore', () => {
  it('records a new command with default rating 1', () => {
    const entry = store.report({ script: 'ls -la', exitCode: 0, cwd: '/home' })
    expect(entry).toMatchObject({ script: 'ls -la', rating: 1, exitCode: 0, cwd: '/home' })
  })

  it('upserts by exact script text and bumps rating', () => {
    store.report({ script: 'kubectl get pods', exitCode: 0 })
    const second = store.report({ script: 'kubectl get pods', exitCode: 1 })
    expect(second?.rating).toBe(2)
    expect(second?.exitCode).toBe(1)
    expect(store.list()).toHaveLength(1)
  })

  it('trims whitespace and rejects empty or oversized scripts', () => {
    expect(store.report({ script: '   ' })).toBeNull()
    expect(store.report({ script: 'x'.repeat(5000) })).toBeNull()
    const entry = store.report({ script: '  git status  ' })
    expect(entry?.script).toBe('git status')
  })

  it('lists entries by recency (descending)', () => {
    store.report({ script: 'first', completedAt: 1000 })
    store.report({ script: 'second', completedAt: 2000 })
    const list = store.list()
    expect(list[0].script).toBe('second')
    expect(list[1].script).toBe('first')
  })

  it('evicts lowest-rated, oldest entries beyond the cap', () => {
    const store2 = new TerminalHistoryStore(tmpDir, 3)
    store2.report({ script: 'a', completedAt: 1 })
    store2.report({ script: 'b', completedAt: 2 })
    store2.report({ script: 'c', completedAt: 3 })
    // 'a' now has rating 2 — survives eviction
    store2.report({ script: 'a', completedAt: 4 })
    store2.report({ script: 'd', completedAt: 5 })
    const scripts = store2
      .list()
      .map((e) => e.script)
      .sort()
    expect(scripts).toEqual(['a', 'c', 'd'])
    store2.dispose()
  })

  it('persists across instances (debounced flush + load)', () => {
    store.report({ script: 'docker ps', exitCode: 0, host: 'root@host:22' })
    store.dispose() // forces flush

    const reloaded = new TerminalHistoryStore(tmpDir)
    const list = reloaded.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ script: 'docker ps', exitCode: 0, host: 'root@host:22' })
    reloaded.dispose()
  })

  it('clear() empties the store', () => {
    store.report({ script: 'x' })
    store.clear()
    expect(store.list()).toHaveLength(0)
  })
})
