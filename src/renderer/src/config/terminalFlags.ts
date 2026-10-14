/**
 * Terminal tab implementation flags.
 *
 * NATIVE_TERMINAL_ENABLED — Raven's own terminal (xterm.js + node-pty + ssh2).
 * CHATERM_TERMINAL_ENABLED — legacy embedded Chaterm webview host.
 *
 * Chaterm code is kept intact for rollback; flip CHATERM_TERMINAL_ENABLED
 * back to true (and NATIVE_TERMINAL_ENABLED to false) to restore it.
 */
export const NATIVE_TERMINAL_ENABLED = true
export const CHATERM_TERMINAL_ENABLED = false
