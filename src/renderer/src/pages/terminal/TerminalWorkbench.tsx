import { TerminalHistoryEntry, TerminalSessionConfig, TerminalSessionInfo } from '@shared/terminal'
import { X } from 'lucide-react'
import { FC, useCallback, useEffect, useState } from 'react'
import styled from 'styled-components'

import { ConnectPanel } from './ConnectPanel'
import { TerminalSessionViews } from './TerminalSessionView'

/**
 * Terminal tab workbench: session tab bar + connect panel + session views.
 * State is component-local — sessions are ephemeral UI state, history lives
 * in the main process (P0-2).
 */
export const TerminalWorkbench: FC = () => {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [history, setHistory] = useState<TerminalHistoryEntry[]>([])
  const [connectError, setConnectError] = useState<string | undefined>(undefined)

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await window.api.terminal.history.list())
    } catch {
      /* history is best-effort */
    }
  }, [])

  useEffect(() => {
    refreshHistory()
  }, [refreshHistory])

  const createSession = useCallback(async (config: TerminalSessionConfig) => {
    setConnectError(undefined)
    try {
      const info = await window.api.terminal.createSession(config)
      setSessions((prev) => [...prev, info])
      setActiveSessionId(info.id)
    } catch (error) {
      setConnectError(String((error as Error)?.message ?? error))
    }
  }, [])

  const handleReconnect = useCallback((session: TerminalSessionInfo) => {
    // The renderer keeps no secrets, so SSH reconnect re-prompts via the
    // connect panel. Close the dead tab for now; an auto-reconnect queue
    // (with stored config in the main process) is a P1 follow-up.
    handleCloseSession(session.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCloseSession = useCallback(async (sessionId: string) => {
    try {
      await window.api.terminal.closeSession(sessionId)
    } catch {
      /* already gone */
    }
    setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    setActiveSessionId((current) => (current === sessionId ? null : current))
  }, [])

  const handleHistoryReport = useCallback(
    (entry: { script: string; exitCode?: number; cwd?: string }) => {
      void window.api.terminal.history
        .report(entry)
        .then(() => refreshHistory())
        .catch(() => undefined)
    },
    [refreshHistory]
  )

  if (sessions.length === 0) {
    return <ConnectPanel onConnect={createSession} error={connectError} />
  }

  return (
    <WorkbenchContainer>
      <TabBar>
        {sessions.map((session) => (
          <Tab key={session.id} $active={session.id === activeSessionId} onClick={() => setActiveSessionId(session.id)}>
            <StatusDot $status={session.status} />
            <TabTitle>{session.title}</TabTitle>
            <CloseButton
              onClick={(e) => {
                e.stopPropagation()
                handleCloseSession(session.id)
              }}>
              <X size={12} />
            </CloseButton>
          </Tab>
        ))}
        <NewTabButton onClick={() => setActiveSessionId(null)}>＋</NewTabButton>
      </TabBar>
      <Stage>
        {activeSessionId === null ? (
          <ConnectPanel
            onConnect={(config) => {
              void createSession(config)
            }}
            error={connectError}
          />
        ) : (
          <TerminalSessionViews
            sessions={sessions}
            activeSessionId={activeSessionId}
            history={history}
            onHistoryReport={handleHistoryReport}
            onReconnect={handleReconnect}
            onClose={handleCloseSession}
          />
        )}
      </Stage>
    </WorkbenchContainer>
  )
}

const WorkbenchContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #141517;
`

const TabBar = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  overflow-x: auto;
`

const Tab = styled.div<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text-2, #bbb);
  background: ${(p) => (p.$active ? 'rgba(255,255,255,0.08)' : 'transparent')};
  white-space: nowrap;

  &:hover {
    background: rgba(255, 255, 255, 0.06);
  }
`

const TabTitle = styled.span`
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
`

const StatusDot = styled.span<{ $status: TerminalSessionInfo['status'] }>`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ $status }) =>
    $status === 'connected'
      ? '#46a758'
      : $status === 'connecting'
        ? '#f5a623'
        : $status === 'error'
          ? '#e5484d'
          : '#666'};
`

const CloseButton = styled.span`
  display: inline-flex;
  opacity: 0.5;
  border-radius: 4px;
  padding: 1px;

  &:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.1);
  }
`

const NewTabButton = styled.button`
  border: none;
  background: transparent;
  color: var(--color-text-3, #888);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 8px;
  border-radius: 6px;

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--color-text);
  }
`

const Stage = styled.div`
  position: relative;
  flex: 1;
  min-height: 0;
`
