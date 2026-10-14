import { TerminalHistoryEntry } from '@shared/terminal'
import { FC, useCallback, useEffect, useMemo } from 'react'
import styled from 'styled-components'

import { acceptSuffix, popupKeyAction, ScoredSuggestion, suggestFromHistory } from './autocomplete'

interface SuggestionPopupProps {
  input: string
  history: TerminalHistoryEntry[]
  /** Invoked with the remaining text to append when a suggestion is accepted. */
  onAccept: (suffix: string) => void
  /** Register the key interceptor; returns an unregister function. */
  visible: boolean
  onDismiss: () => void
}

/**
 * History-based command suggestion popup (P0-2 consumer).
 *
 * The parent owns keyboard routing: it forwards key events to
 * `popupKeyAction` and drives `activeIndex` through the exposed callbacks.
 */
export const SuggestionPopup: FC<
  SuggestionPopupProps & { activeIndex: number; onActiveIndexChange: (i: number) => void }
> = ({ input, history, onAccept, visible, onDismiss, activeIndex, onActiveIndexChange }) => {
  const suggestions = useMemo<ScoredSuggestion[]>(() => suggestFromHistory(history, input), [history, input])

  useEffect(() => {
    if (activeIndex >= suggestions.length) onActiveIndexChange(Math.max(0, suggestions.length - 1))
  }, [suggestions.length, activeIndex, onActiveIndexChange])

  if (!visible || suggestions.length === 0) return null

  return (
    <Popup>
      <Header>
        <span>{suggestions.length} suggestions</span>
        <Hint>↑↓ navigate · Tab/Enter accept · Esc dismiss</Hint>
      </Header>
      <List>
        {suggestions.map((s, i) => (
          <Item
            key={`${s.entry.script}-${i}`}
            $active={i === activeIndex}
            onMouseEnter={() => onActiveIndexChange(i)}
            onMouseDown={(e) => {
              e.preventDefault()
              const suffix = acceptSuffix(s.entry, input)
              if (suffix !== null) onAccept(suffix)
              onDismiss()
            }}>
            <Script title={s.entry.script}>{s.entry.script}</Script>
            <Meta>
              {s.entry.exitCode !== undefined && (
                <ExitCode $failed={s.entry.exitCode !== 0}>exit {s.entry.exitCode}</ExitCode>
              )}
              <Rating>×{s.entry.rating}</Rating>
            </Meta>
          </Item>
        ))}
      </List>
    </Popup>
  )
}

/** Imperative controller used by TerminalSessionView to route keyboard events. */
export function useSuggestionKeys(
  hasSuggestions: boolean,
  callbacks: {
    onNavigate: (diff: number) => void
    onAccept: () => void
    onDismiss: () => void
  }
): (event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) => boolean {
  return useCallback(
    (event) => {
      if (!hasSuggestions) return true
      const action = popupKeyAction(event.key, event.altKey, event.ctrlKey, event.metaKey)
      switch (action) {
        case 'navigateDown':
          callbacks.onNavigate(1)
          return false
        case 'navigateUp':
          callbacks.onNavigate(-1)
          return false
        case 'accept':
          callbacks.onAccept()
          return false
        case 'dismiss':
          callbacks.onDismiss()
          return false
        default:
          return true
      }
    },
    [hasSuggestions, callbacks]
  )
}

const Popup = styled.div`
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 20;
  min-width: 320px;
  max-width: 70%;
  background: var(--color-background-2, #1b1d21);
  border: 1px solid var(--color-border, #333);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  overflow: hidden;
`

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--color-text-3, #888);
  border-bottom: 1px solid var(--color-border, #333);
`

const Hint = styled.span`
  opacity: 0.7;
`

const List = styled.ul`
  margin: 0;
  padding: 4px;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
`

const Item = styled.li<{ $active: boolean }>`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 5px 8px;
  border-radius: 5px;
  cursor: pointer;
  background: ${(p) => (p.$active ? 'var(--color-background-3, #2a2d33)' : 'transparent')};
`

const Script = styled.span`
  font-family: var(--font-family-mono, monospace);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const Meta = styled.span`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  font-size: 11px;
`

const ExitCode = styled.span<{ $failed: boolean }>`
  color: ${(p) => (p.$failed ? 'var(--color-error, #e5484d)' : 'var(--color-success, #46a758)')};
`

const Rating = styled.span`
  color: var(--color-text-3, #888);
`
