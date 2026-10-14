import { NATIVE_TERMINAL_ENABLED } from '@renderer/config/terminalFlags'
import { TerminalSquare } from 'lucide-react'
import { FC, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import styled from 'styled-components'

import { TerminalWorkbench } from './TerminalWorkbench'

/**
 * Route element for /terminal.
 *
 * With NATIVE_TERMINAL_ENABLED the tab renders Raven's own terminal
 * (xterm.js + node-pty + ssh2, see docs/technical/native-terminal-design.md).
 * Otherwise it falls back to the legacy embedded-Chaterm guard, where the
 * <webview> lives in ChatermWebviewHost (mounted outside the Routes tree).
 */
const TerminalPage: FC = () => {
  const { t } = useTranslation()
  const [status, setStatus] = useState<{ hasAssets: boolean } | null>(null)

  useEffect(() => {
    if (NATIVE_TERMINAL_ENABLED) return
    window.api.chaterm
      .getStatus()
      .then((s) => setStatus(s))
      .catch(() => setStatus({ hasAssets: false }))
  }, [])

  if (NATIVE_TERMINAL_ENABLED) {
    return <TerminalWorkbench />
  }

  // Legacy Chaterm path — still fetching status, render nothing.
  if (status === null) return null

  // §6.2: route guard — redirect if Chaterm resources not found
  if (!status.hasAssets) {
    return (
      <Container>
        <TerminalSquare size={48} strokeWidth={1.5} />
        <Title>{t('terminal.title')}</Title>
        <Subtitle>{t('terminal.notAvailable', 'Terminal is not available. Chaterm resources not found.')}</Subtitle>
      </Container>
    )
  }

  // Chaterm assets exist — ChatermWebviewHost handles the webview rendering.
  return null
}

export const TerminalRedirect: FC = () => {
  return <Navigate to="/" replace />
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--color-text-2);
`

const Title = styled.h2`
  font-size: 18px;
  font-weight: 500;
  color: var(--color-text);
  margin: 0;
`

const Subtitle = styled.p`
  font-size: 14px;
  margin: 0;
`

export default TerminalPage
