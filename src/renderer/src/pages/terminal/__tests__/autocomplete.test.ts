import { TerminalHistoryEntry } from '@shared/terminal'
import { describe, expect, it } from 'vitest'

import { acceptSuffix, popupKeyAction, suggestFromHistory } from '../autocomplete'

const entry = (script: string, rating = 1, completedAt = 0, exitCode?: number): TerminalHistoryEntry => ({
  script,
  rating,
  completedAt,
  exitCode
})

const history = [
  entry('kubectl get pods -n prod', 5, 100),
  entry('kubectl logs pod-1 -n prod', 2, 200),
  entry('git status', 3, 300),
  entry('docker ps -a', 1, 400)
]

describe('suggestFromHistory', () => {
  it('returns nothing for empty or too-short input', () => {
    expect(suggestFromHistory(history, '')).toHaveLength(0)
    expect(suggestFromHistory(history, 'k')).toHaveLength(0)
  })

  it('excludes the exact current input', () => {
    expect(suggestFromHistory(history, 'git status')).toHaveLength(0)
  })

  it('ranks prefix matches above substring matches and by rating', () => {
    const result = suggestFromHistory([entry('kubectl logs x'), entry('kubectl get pods', 2)], 'kubectl', 5)
    expect(result[0].tier).toBe(2)
    expect(result[0].entry.script).toBe('kubectl get pods') // higher rating within tier
  })

  it('sorts by rating then recency within a tier', () => {
    const result = suggestFromHistory(history, 'kubectl', 5)
    expect(result.map((r) => r.entry.script)).toEqual(['kubectl get pods -n prod', 'kubectl logs pod-1 -n prod'])
  })

  it('respects the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => entry(`kubectl scale ${i}`, i + 1, i))
    expect(suggestFromHistory(many, 'kubectl', 3)).toHaveLength(3)
  })
})

describe('acceptSuffix', () => {
  it('returns the remaining text after the typed prefix', () => {
    expect(acceptSuffix(entry('kubectl get pods'), 'kubectl get')).toBe(' pods')
  })

  it('returns null when there is nothing to append or no prefix match', () => {
    expect(acceptSuffix(entry('kubectl get pods'), 'kubectl get pods')).toBeNull()
    expect(acceptSuffix(entry('kubectl get pods'), 'logs')).toBeNull()
  })
})

describe('popupKeyAction', () => {
  it('maps navigation/accept/dismiss keys', () => {
    expect(popupKeyAction('ArrowDown', false, false, false)).toBe('navigateDown')
    expect(popupKeyAction('ArrowUp', false, false, false)).toBe('navigateUp')
    expect(popupKeyAction('Tab', false, false, false)).toBe('accept')
    expect(popupKeyAction('Enter', false, false, false)).toBe('accept')
    expect(popupKeyAction('Escape', false, false, false)).toBe('dismiss')
  })

  it('ignores modified keys and non-single-char keys', () => {
    expect(popupKeyAction('ArrowDown', false, true, false)).toBe('ignore')
    expect(popupKeyAction('ArrowDown', false, false, true)).toBe('ignore')
    expect(popupKeyAction('F1', false, false, false)).toBe('ignore')
    expect(popupKeyAction('a', false, false, false)).toBe('typing')
    expect(popupKeyAction('Backspace', false, false, false)).toBe('typing')
  })
})
