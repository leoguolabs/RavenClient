/**
 * Tracks the user's current input line by observing the data the terminal
 * sends to the PTY. Best-effort by design: it exists to feed the history
 * suggestion popup, not to be a line editor.
 *
 * Handles: printable input, backspace/delete, Ctrl-C / Ctrl-U reset, Enter
 * (submit → reset), multi-char paste, and alt-screen deactivation (vim etc.).
 */
export class InputLineTracker {
  private buffer = ''
  private altScreen = false
  private inEscape = false

  get currentLine(): string {
    return this.buffer
  }

  /** Called with the same data that is written to the PTY. */
  onData(data: string): void {
    // Alt-screen transitions must be processed even while suppressed, so that
    // leaving vim/less re-enables tracking.
    if (data.includes('\x1b[?1049h') || data.includes('\x1b[?1049l')) {
      this.altScreen = data.includes('\x1b[?1049h')
      this.buffer = ''
      return
    }
    if (this.altScreen) return
    for (const ch of data) {
      this.consume(ch)
    }
  }

  /** Session was reset (e.g. reconnect). */
  reset(): void {
    this.buffer = ''
    this.altScreen = false
  }

  private consume(ch: string): void {
    // Skip escape sequences (CSI ends with a letter, two-char sequences like
    // ESC O P end with a letter too). Best-effort — enough for input tracking.
    if (this.inEscape) {
      if (/[A-Za-z]/.test(ch)) this.inEscape = false
      return
    }
    if (ch === '\x1b') {
      this.inEscape = true
      return
    }
    if (ch === '\r' || ch === '\n') {
      this.buffer = ''
      return
    }
    if (ch === '\x03' || ch === '\x04' || ch === '\x15' /* Ctrl-C/D/U */) {
      this.buffer = ''
      return
    }
    if (ch === '\x7f' || ch === '\b') {
      this.buffer = this.buffer.slice(0, -1)
      return
    }
    // Ignore other control sequences/characters.
    const code = ch.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return
    this.buffer += ch
    if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-4096)
  }
}
