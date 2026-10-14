import { describe, expect, it } from 'vitest'

import { InputLineTracker } from '../inputTracker'

describe('InputLineTracker', () => {
  it('accumulates printable input', () => {
    const tracker = new InputLineTracker()
    for (const ch of 'kubectl get') tracker.onData(ch)
    expect(tracker.currentLine).toBe('kubectl get')
  })

  it('handles paste as a multi-char chunk', () => {
    const tracker = new InputLineTracker()
    tracker.onData('docker compose up -d')
    expect(tracker.currentLine).toBe('docker compose up -d')
  })

  it('handles backspace', () => {
    const tracker = new InputLineTracker()
    tracker.onData('git stat')
    tracker.onData('\x7f')
    expect(tracker.currentLine).toBe('git sta')
  })

  it('resets on Enter and Ctrl-C', () => {
    const tracker = new InputLineTracker()
    tracker.onData('some command')
    tracker.onData('\r')
    expect(tracker.currentLine).toBe('')
    tracker.onData('again')
    tracker.onData('\x03')
    expect(tracker.currentLine).toBe('')
  })

  it('ignores data while the alternate screen is active (vim etc.)', () => {
    const tracker = new InputLineTracker()
    tracker.onData('vi\x1b[?1049h')
    tracker.onData('jjjj:wq')
    expect(tracker.currentLine).toBe('')
    // Leaving alt screen resets tracking.
    tracker.onData('\x1b[?1049l')
    tracker.onData('ls')
    expect(tracker.currentLine).toBe('ls')
  })

  it('ignores other control characters', () => {
    const tracker = new InputLineTracker()
    tracker.onData('ls\x1b[A\x01')
    expect(tracker.currentLine).toBe('ls')
  })
})
