import '@xterm/xterm/css/xterm.css'

import { TerminalHistoryEntry, TerminalSessionInfo } from '@shared/terminal'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { FC, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { suggestFromHistory } from './autocomplete'
import { InputLineTracker } from './inputTracker'
import { RavenOsc4545Addon } from './osc4545Addon'
import { SuggestionPopup, useSuggestionKeys } from './SuggestionPopup'

interface TerminalViewProps {
  session: TerminalSessionInfo
  isActive: boolean
  history: TerminalHistoryEntry[]
  onHistoryReport: (entry: { script: string; exitCode?: number; cwd?: string }) => void
}

/**
 * One terminal session: an xterm instance wired to the main-process session,
 * with OSC 4545 parsing (P0-1) feeding history reporting (P0-2) and the
 * suggestion popup.
 */
const TerminalView: FC<TerminalViewProps> = ({ session, isActive, history, onHistoryReport }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const trackerRef = useRef(new InputLineTracker())
  const [input, setInput] = useState('')
  const [popupOpen, setPopupOpen] = useState(true)
  const [activeIndex, setActiveIndex] = useState(0)
  const [cwd, setCwd] = useState<string | null>(null)
  const [lastExit, setLastExit] = useState<{ code: number } | null>(null)
  const { t } = useTranslation()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrainsMono Nerd Font Mono', 'Cascadia Mono', Menlo, Consolas, monospace",
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#141517',
        foreground: '#d4d4d4',
        cursor: '#aeafad',
        selectionBackground: '#3a3d41'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    term.focus()
    termRef.current = term
    fitRef.current = fit

    // P0-1: parse Raven OSC 4545 shell integration events.
    const cwdRef = { current: '' }
    const oscAddon = new RavenOsc4545Addon({
      onCwd: (value) => {
        cwdRef.current = value
        setCwd(value)
      },
      onCommandStarted: () => {
        // Command boundary — nothing to render; history reported on exit.
      },
      onCommandExited: (exitCode) => {
        setLastExit({ code: exitCode })
        const script = trackerRef.current.currentLine.trim()
        trackerRef.current.reset()
        setInput('')
        if (script) {
          onHistoryReport({ script, exitCode, cwd: cwdRef.current || undefined })
        }
      }
    })
    oscAddon.activate(term as unknown as Parameters<RavenOsc4545Addon['activate']>[0])

    // Wire PTY data flow.
    const unsubData = window.api.terminal.onData(session.id, (chunk) => {
      term.write(chunk)
    })
    const unsubStatus = window.api.terminal.onStatus(session.id, (info) => {
      // Status updates are surfaced by the parent via session info refresh.
      void info
    })
    const unsubExit = window.api.terminal.onExit(session.id, () => {
      /* exit overlay handled by parent via status */
    })

    // Input: mirror into the tracker, then forward to the PTY.
    const dataDisposable = term.onData((data) => {
      trackerRef.current.onData(data)
      setInput(trackerRef.current.currentLine)
      window.api.terminal.write(session.id, data)
    })

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      window.api.terminal.resize(session.id, cols, rows)
    })

    // Fit on container resize (debounced via rAF).
    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {
          /* container detached */
        }
      })
    })
    observer.observe(container)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      unsubData()
      unsubStatus()
      unsubExit()
      oscAddon.dispose()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // Refocus the terminal when the tab becomes active.
  useEffect(() => {
    if (isActive) termRef.current?.focus()
  }, [isActive])

  const suggestions = suggestFromHistory(history, input)
  const hasSuggestions = popupOpen && isActive && suggestions.length > 0

  const navigate = (diff: number) => {
    setActiveIndex((i) => {
      const next = i + diff
      if (next < 0) return suggestions.length - 1
      if (next >= suggestions.length) return 0
      return next
    })
  }

  const acceptActive = () => {
    const chosen = suggestions[activeIndex] ?? suggestions[0]
    if (!chosen) return
    const query = input.trim()
    const suffix = chosen.entry.script.startsWith(query) ? chosen.entry.script.slice(query.length) : null
    if (suffix) {
      termRef.current?.write(suffix)
      trackerRef.current.onData(suffix)
      setInput(trackerRef.current.currentLine)
    }
    setPopupOpen(false)
  }

  const handleKeyEvent = useSuggestionKeys(hasSuggestions, {
    onNavigate: navigate,
    onAccept: acceptActive,
    onDismiss: () => setPopupOpen(false)
  })

  // Route keys through xterm's custom key handler while the popup is open.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const handler = (event: KeyboardEvent): boolean => {
      if (!hasSuggestions) return true
      return handleKeyEvent(event)
    }
    term.attachCustomKeyEventHandler(handler)
    return () => {
      // Reset the handler by attaching a pass-through one on cleanup.
      term.attachCustomKeyEventHandler(() => true)
    }
  }, [hasSuggestions, handleKeyEvent])

  return (
    <ViewContainer>
      <TermContainer ref={containerRef} $visible={isActive} />
      <SuggestionPopup
        input={input}
        history={history}
        visible={hasSuggestions}
        activeIndex={activeIndex}
        onActiveIndexChange={setActiveIndex}
        onAccept={acceptActive}
        onDismiss={() => setPopupOpen(false)}
      />
      <StatusBar>
        <StatusItem>{session.title}</StatusItem>
        {cwd && <StatusItem title={cwd}>📄 {cwd}</StatusItem>}
        {lastExit && (
          <StatusItem $failed={lastExit.code !== 0}>
            {t('terminal.lastExitCode', 'last exit')} {lastExit.code}
          </StatusItem>
        )}
        {session.hostKeyFingerprint && (
          <StatusItem title={session.hostKeyFingerprint}>
            {t('terminal.hostKeyVerified', 'host key verified')}
          </StatusItem>
        )}
      </StatusBar>
    </ViewContainer>
  )
}

interface WorkbenchProps {
  sessions: TerminalSessionInfo[]
  activeSessionId: string | null
  history: TerminalHistoryEntry[]
  onHistoryReport: (entry: { script: string; exitCode?: number; cwd?: string }) => void
  onReconnect: (session: TerminalSessionInfo) => void
  onClose: (sessionId: string) => void
}

export const TerminalSessionViews: FC<WorkbenchProps> = ({
  sessions,
  activeSessionId,
  history,
  onHistoryReport,
  onReconnect,
  onClose
}) => {
  return (
    <>
      {sessions.map((session) => (
        <SessionShell key={session.id} $visible={session.id === activeSessionId}>
          <TerminalView
            session={session}
            isActive={session.id === activeSessionId}
            history={history}
            onHistoryReport={onHistoryReport}
          />
          {(session.status === 'closed' || session.status === 'error') && (
            <EndedOverlay>
              <span>{session.error || (session.status === 'closed' ? 'Session ended' : 'Connection failed')}</span>
              <Buttons>
                <button type="button" onClick={() => onReconnect(session)}>
                  Reconnect
                </button>
                <button type="button" onClick={() => onClose(session.id)}>
                  Close tab
                </button>
              </Buttons>
            </EndedOverlay>
          )}
        </SessionShell>
      ))}
    </>
  )
}

const ViewContainer = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: #141517;
`

const TermContainer = styled.div<{ $visible: boolean }>`
  flex: 1;
  min-height: 0;
  padding: 4px 8px;
  visibility: ${(p) => (p.$visible ? 'visible' : 'hidden')};
`

const StatusBar = styled.div`
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 3px 10px;
  font-size: 11px;
  color: var(--color-text-3, #888);
  background: rgba(255, 255, 255, 0.04);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
`

const StatusItem = styled.span<{ $failed?: boolean }>`
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${(p) => (p.$failed ? 'var(--color-error, #e5484d)' : 'inherit')};
`

const SessionShell = styled.div<{ $visible: boolean }>`
  position: absolute;
  inset: 0;
  display: ${(p) => (p.$visible ? 'block' : 'none')};
`

const EndedOverlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(0, 0, 0, 0.55);
  color: var(--color-text, #eee);
  font-size: 14px;
`

const Buttons = styled.div`
  display: flex;
  gap: 8px;

  button {
    padding: 5px 14px;
    border-radius: 6px;
    border: 1px solid var(--color-border, #444);
    background: var(--color-background-2, #222);
    color: var(--color-text, #eee);
    cursor: pointer;

    &:hover {
      background: var(--color-background-3, #2c2c2c);
    }
  }
`
