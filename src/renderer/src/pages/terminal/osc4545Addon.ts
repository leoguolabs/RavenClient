import { OSC_RAVEN_SHELL_INTEGRATION, parseRavenOsc, RavenOscAction } from '@shared/terminal'

type TerminalLike = {
  parser: {
    registerOscHandler(
      ident: number,
      callback: (data: string) => boolean | Promise<boolean>
    ): {
      dispose(): void
    }
  }
}

export interface RavenOsc4545Handlers {
  onCwd?: (cwd: string) => void
  onCommandStarted?: (script: string) => void
  onCommandExited?: (exitCode: number) => void
  onPromptBegins?: () => void
  onPromptEnds?: () => void
}

/**
 * xterm.js addon that consumes the Raven OSC 4545 shell-integration protocol
 * (P0-1) and exposes typed callbacks. Mirrors the Termius
 * ShellIntegrationBridgeAddon architecture.
 */
export class RavenOsc4545Addon {
  private disposable: { dispose(): void } | null = null

  constructor(private readonly handlers: RavenOsc4545Handlers) {}

  activate(terminal: TerminalLike): void {
    this.disposable = terminal.parser.registerOscHandler(OSC_RAVEN_SHELL_INTEGRATION, (data) => {
      this.handle(data)
      return true // handled — do not render the sequence
    })
  }

  dispose(): void {
    this.disposable?.dispose()
    this.disposable = null
  }

  /** Exposed for tests. */
  handle(data: string): RavenOscAction | null {
    const action = parseRavenOsc(data)
    if (!action) return null
    switch (action.type) {
      case 'cwd':
        this.handlers.onCwd?.(action.cwd)
        break
      case 'commandStarted':
        this.handlers.onCommandStarted?.(action.script)
        break
      case 'commandExited':
        this.handlers.onCommandExited?.(action.exitCode)
        break
      case 'promptBegins':
        this.handlers.onPromptBegins?.()
        break
      case 'promptEnds':
        this.handlers.onPromptEnds?.()
        break
    }
    return action
  }
}
