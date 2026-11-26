import { isMac } from './constant'

// Keep Terminal AI available on macOS while the native workbench gains AI support.
export const CHATERM_TERMINAL_ENABLED = isMac
