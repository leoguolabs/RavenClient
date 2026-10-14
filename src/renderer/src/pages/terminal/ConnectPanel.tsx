import { TerminalLocalSessionConfig, TerminalSessionConfig, TerminalSshSessionConfig } from '@shared/terminal'
import { Plus, TerminalSquare } from 'lucide-react'
import { FC, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface ConnectPanelProps {
  onConnect: (config: TerminalSessionConfig) => void
  error?: string
}

type AuthMode = 'password' | 'key'

/**
 * Landing panel of the Terminal tab: open a local shell or connect to an SSH
 * host (password / private key auth).
 */
export const ConnectPanel: FC<ConnectPanelProps> = ({ onConnect, error }) => {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'ssh' | 'local'>('ssh')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [authMode, setAuthMode] = useState<AuthMode>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const submitSsh = () => {
    if (!host.trim() || !username.trim()) return
    const auth: TerminalSshSessionConfig['auth'] =
      authMode === 'password'
        ? { type: 'password', password }
        : { type: 'key', privateKey, passphrase: passphrase || undefined }
    const config: TerminalSshSessionConfig = {
      type: 'ssh',
      host: host.trim(),
      port: Number.parseInt(port, 10) || 22,
      username: username.trim(),
      auth
    }
    onConnect(config)
  }

  const submitLocal = () => {
    const config: TerminalLocalSessionConfig = { type: 'local' }
    onConnect(config)
  }

  return (
    <Container>
      <Icon>
        <TerminalSquare size={40} strokeWidth={1.2} />
      </Icon>
      <Title>{t('terminal.title')}</Title>

      <ModeSwitch>
        <ModeButton $active={mode === 'ssh'} onClick={() => setMode('ssh')}>
          SSH
        </ModeButton>
        <ModeButton $active={mode === 'local'} onClick={() => setMode('local')}>
          {t('terminal.localShell', 'Local Shell')}
        </ModeButton>
      </ModeSwitch>

      {mode === 'ssh' ? (
        <Form onSubmit={(e) => e.preventDefault()}>
          <Row>
            <Field>
              <Label>{t('terminal.host', 'Host')}</Label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" autoFocus />
            </Field>
            <Field $narrow>
              <Label>{t('terminal.port', 'Port')}</Label>
              <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
            </Field>
          </Row>
          <Field>
            <Label>{t('terminal.username', 'Username')}</Label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </Field>
          <Row>
            <Field>
              <Label>{t('terminal.authType', 'Auth')}</Label>
              <select value={authMode} onChange={(e) => setAuthMode(e.target.value as AuthMode)}>
                <option value="password">{t('terminal.authPassword', 'Password')}</option>
                <option value="key">{t('terminal.authKey', 'Private Key')}</option>
              </select>
            </Field>
            {authMode === 'password' ? (
              <Field>
                <Label>{t('terminal.password', 'Password')}</Label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            ) : (
              <Field>
                <Label>{t('terminal.privateKey', 'Private Key (PEM)')}</Label>
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  rows={3}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </Field>
            )}
          </Row>
          {authMode === 'key' && (
            <Field>
              <Label>{t('terminal.passphrase', 'Key Passphrase (optional)')}</Label>
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
          )}
          {error && <ErrorText>{error}</ErrorText>}
          <Submit type="submit" onClick={submitSsh}>
            {t('terminal.connect', 'Connect')}
          </Submit>
        </Form>
      ) : (
        <Form onSubmit={(e) => e.preventDefault()}>
          <Description>
            {t('terminal.localShellDescription', 'Open a PTY running your default login shell.')}
          </Description>
          {error && <ErrorText>{error}</ErrorText>}
          <Submit type="submit" onClick={submitLocal}>
            <Plus size={14} /> {t('terminal.openLocalShell', 'Open Local Shell')}
          </Submit>
        </Form>
      )}
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 14px;
  color: var(--color-text);
`

const Icon = styled.div`
  color: var(--color-text-3);
`

const Title = styled.h2`
  font-size: 18px;
  font-weight: 500;
  margin: 0;
`

const ModeSwitch = styled.div`
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: var(--color-background-2, #1b1d21);
`

const ModeButton = styled.button<{ $active: boolean }>`
  padding: 5px 16px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-size: 13px;
  background: ${(p) => (p.$active ? 'var(--color-background-3, #2a2d33)' : 'transparent')};
  color: ${(p) => (p.$active ? 'var(--color-text)' : 'var(--color-text-3)')};
`

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 380px;
  padding: 16px;
  border-radius: 10px;
  background: var(--color-background-2, #1b1d21);
`

const Row = styled.div`
  display: flex;
  gap: 10px;
`

const Field = styled.div<{ $narrow?: boolean }>`
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: ${(p) => (p.$narrow ? '0 0 90px' : '1')};

  input,
  textarea,
  select {
    background: var(--color-background, #141517);
    border: 1px solid var(--color-border, #333);
    border-radius: 6px;
    padding: 6px 8px;
    color: var(--color-text);
    font-size: 13px;
    outline: none;

    &:focus {
      border-color: var(--color-primary, #4c7dff);
    }
  }

  textarea {
    font-family: var(--font-family-mono, monospace);
    font-size: 11px;
    resize: vertical;
  }
`

const Label = styled.label`
  font-size: 12px;
  color: var(--color-text-3);
`

const Description = styled.p`
  margin: 0;
  font-size: 13px;
  color: var(--color-text-3);
`

const ErrorText = styled.p`
  margin: 0;
  font-size: 12px;
  color: var(--color-error, #e5484d);
`

const Submit = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-size: 14px;
  background: var(--color-primary, #4c7dff);
  color: #fff;

  &:hover {
    filter: brightness(1.1);
  }
`
