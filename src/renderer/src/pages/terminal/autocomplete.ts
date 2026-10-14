import { TerminalHistoryEntry } from '@shared/terminal'

/**
 * History-based command suggestion matching (P0-2 consumer).
 *
 * Pure logic, no xterm/UI dependencies. Ranking mirrors the Termius model:
 * prefix matches beat substring matches; within a tier, higher rating wins,
 * then recency; shorter commands win ties (more likely to be the wanted one).
 */
export interface ScoredSuggestion {
  entry: TerminalHistoryEntry
  /** 2 = prefix match, 1 = substring match. */
  tier: 1 | 2
}

export function suggestFromHistory(history: TerminalHistoryEntry[], input: string, limit = 5): ScoredSuggestion[] {
  const query = input.trim()
  if (!query || query.length < 2) return []

  const suggestions: ScoredSuggestion[] = []
  for (const entry of history) {
    if (entry.script === query) continue
    const idx = entry.script.indexOf(query)
    if (idx === -1) continue
    suggestions.push({ entry, tier: idx === 0 ? 2 : 1 })
  }

  return suggestions
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        b.entry.rating - a.entry.rating ||
        b.entry.completedAt - a.entry.completedAt ||
        a.entry.script.length - b.entry.script.length
    )
    .slice(0, limit)
}

/**
 * The remaining text to append when accepting a suggestion, given the current
 * input. Returns null when there is nothing to append.
 */
export function acceptSuffix(suggestion: TerminalHistoryEntry, input: string): string | null {
  const query = input.trim()
  if (!suggestion.script.startsWith(query)) return null
  const suffix = suggestion.script.slice(query.length)
  return suffix.length > 0 ? suffix : null
}

/** Is the key event one that should keep the suggestion popup interactive? */
export type PopupKeyAction = 'navigateDown' | 'navigateUp' | 'accept' | 'dismiss' | 'typing' | 'ignore'

export function popupKeyAction(key: string, altKey: boolean, ctrlKey: boolean, metaKey: boolean): PopupKeyAction {
  if (ctrlKey || metaKey) return 'ignore'
  switch (key) {
    case 'ArrowDown':
      return altKey ? 'ignore' : 'navigateDown'
    case 'ArrowUp':
      return altKey ? 'ignore' : 'navigateUp'
    case 'Tab':
    case 'Enter':
      return 'accept'
    case 'Escape':
      return 'dismiss'
    default:
      return key.length === 1 || key === 'Backspace' || key === 'Delete' || key === 'Space' ? 'typing' : 'ignore'
  }
}
