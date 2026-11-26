import { loggerService } from '@logger'
import { isMac } from '@renderer/config/constant'
import { useNotification } from '@renderer/context/NotificationProvider'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useSettings } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import { IpcChannel } from '@shared/IpcChannel'
import { Button } from 'antd'
import type { WebviewTag } from 'electron'
import { FC, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

type LoadState = 'idle' | 'loading' | 'loaded' | 'crashed'
type HostWarnPayload = {
  code?: string
  message?: string
}

const CHATERM_APP_URL = 'raven-chaterm://app/index.html'
const BLANK_WEBVIEW_URL = 'about:blank'
const RAVEN_SESSION_HANDOFF_TIMEOUT = 'raven.session.handoff.timeout'
const logger = loggerService.withContext('ChatermWebviewHost')

/**
 * Renders and manages the Chaterm <webview> outside the Routes tree so the
 * process (and any live SSH sessions) survive route changes.
 *
 * §6.3 – webview src / preload / webpreferences
 * §6.4 – lazy first mount, display:none on tab-away
 * §6.5 – loading overlay
 * §6.6 – crash overlay + reload
 * §6.7 – block remote navigation
 * §6.8 – theme / locale broadcast
 * §6.9 – raven:ui:navigate reverse IPC
 */
const ChatermWebviewHost: FC<{ fallback?: ReactNode }> = ({ fallback }) => {
  const location = useLocation()
  const navigate = useNavigate()
  const { theme } = useTheme()
  const { language } = useSettings()
  const isFullscreen = useFullscreen()
  const { t } = useTranslation()
  const notification = useNotification()

  const webviewRef = useRef<WebviewTag | null>(null)
  const attachStartedRef = useRef(false)
  const navigatedToAppRef = useRef(false)
  const loadedRef = useRef(false)
  const sessionSyncedAfterAppReadyRef = useRef(false)
  // Track whether the webview has ever been mounted so we can keep it alive
  const everMountedRef = useRef(false)

  const [preloadUrl, setPreloadUrl] = useState<string | null | undefined>(undefined)
  const [loadState, setLoadState] = useState<LoadState>('idle')

  const isVisible = location.pathname === '/terminal'

  // Mark as ever-mounted the first time the route becomes active
  if (isVisible && !everMountedRef.current) {
    everMountedRef.current = true
  }

  // Query Chaterm status once on mount
  useEffect(() => {
    window.api.chaterm
      .getStatus()
      .then((status) => setPreloadUrl(status.isEnabled && status.preloadPath ? status.preloadPath : null))
      .catch((error: Error) => {
        logger.warn('Failed to check Chaterm availability', error)
        setPreloadUrl(null)
      })
  }, [])

  // §6.9: listen for raven:ui:navigate from Chaterm (via ipc-message OR from main process relay)
  useEffect(() => {
    const cleanup = window.api.chaterm.onNavigate((path) => {
      navigate(path)
    })
    return () => {
      cleanup()
    }
  }, [navigate])

  // §6.6: listen for crash notifications forwarded by the main process
  useEffect(() => {
    const cleanup = window.api.chaterm.onWebviewCrashed(() => {
      setLoadState('crashed')
    })
    return () => {
      cleanup()
    }
  }, [])

  // §6.8: broadcast theme changes to Chaterm webview
  useEffect(() => {
    if (loadState !== 'loaded' || !webviewRef.current) return
    webviewRef.current.send(IpcChannel.Raven_UI_ThemeChanged, { theme })
  }, [theme, loadState])

  // §6.8: broadcast locale changes to Chaterm webview
  useEffect(() => {
    if (loadState !== 'loaded' || !webviewRef.current) return
    webviewRef.current.send(IpcChannel.Raven_UI_LocaleChanged, { locale: i18n.language })
  }, [language, loadState])

  const resetNavigationState = useCallback(() => {
    attachStartedRef.current = false
    navigatedToAppRef.current = false
    loadedRef.current = false
    sessionSyncedAfterAppReadyRef.current = false
  }, [])

  const isAtChatermAppUrl = useCallback((element: WebviewTag) => {
    const currentUrl = typeof element.getURL === 'function' ? element.getURL() : ''
    return currentUrl.startsWith(CHATERM_APP_URL)
  }, [])

  const sendInitialState = useCallback(
    (element: WebviewTag) => {
      element.send(IpcChannel.Raven_UI_ThemeChanged, { theme })
      element.send(IpcChannel.Raven_UI_LocaleChanged, { locale: i18n.language })
    },
    [theme]
  )

  const markLoaded = useCallback(
    (element: WebviewTag, origin: string) => {
      if (loadedRef.current || !navigatedToAppRef.current || !isAtChatermAppUrl(element)) return
      loadedRef.current = true
      console.info('[ChatermWebviewHost] webview loaded via', origin)
      setLoadState('loaded')
      sendInitialState(element)
    },
    [isAtChatermAppUrl, sendInitialState]
  )

  const syncSessionAfterAppReady = useCallback(
    (element: WebviewTag) => {
      if (sessionSyncedAfterAppReadyRef.current || !navigatedToAppRef.current || !isAtChatermAppUrl(element)) return
      sessionSyncedAfterAppReadyRef.current = true
      const id = element.getWebContentsId()
      void window.api.chaterm.attachWebview(id).catch((err) => {
        sessionSyncedAfterAppReadyRef.current = false
        logger.warn('raven.chaterm.session_resync.failed', { error: (err as Error).message })
      })
    },
    [isAtChatermAppUrl]
  )

  const openLogs = useCallback(async () => {
    try {
      const info = await window.api.getAppInfo()
      if (info?.logsPath) {
        await window.api.openPath(info.logsPath)
      }
    } catch (err) {
      logger.warn('raven.chaterm.open_logs.failed', { error: (err as Error).message })
    }
  }, [])

  const showHostWarning = useCallback(
    (payload: HostWarnPayload) => {
      const message = payload?.message || t('terminal.host_warning', 'Terminal initialization failed')
      logger.error('raven.chaterm.host_warn', payload, { logToMain: true })
      notification.open({
        type: 'warning',
        message,
        description: payload?.code,
        duration: 6,
        placement: 'topRight',
        actions: (
          <Button size="small" onClick={openLogs}>
            {t('terminal.view_logs', 'View logs')}
          </Button>
        )
      })
    },
    [notification, openLogs, t]
  )

  const attachAndNavigate = useCallback(
    async (element: WebviewTag) => {
      if (attachStartedRef.current) return
      attachStartedRef.current = true
      setLoadState('loading')

      const id = element.getWebContentsId()
      try {
        await window.api.chaterm.attachWebview(id)
        if (webviewRef.current !== element) return
        navigatedToAppRef.current = true
        await element.loadURL(CHATERM_APP_URL)
        if (webviewRef.current !== element) return
        markLoaded(element, 'loadURL')
      } catch (err) {
        attachStartedRef.current = false
        console.error('[ChatermWebviewHost] attachWebview failed:', err)
        setLoadState('crashed')
      }
    },
    [markLoaded]
  )

  const setRef = useCallback(
    (element: WebviewTag | null) => {
      webviewRef.current = element
      if (!element) {
        resetNavigationState()
        return
      }

      // §6.5: loading indicators
      const onStartLoading = () => {
        if (!loadedRef.current) {
          setLoadState('loading')
        }
      }
      const onFinishLoad = () => {
        syncSessionAfterAppReady(element)
        markLoaded(element, 'did-finish-load')
      }
      // dom-ready is also our signal that getWebContentsId() is safe to call.
      // Calling it synchronously from the React ref callback throws because
      // the webview hasn't attached + emitted dom-ready yet.
      const onDomReady = () => {
        if (!attachStartedRef.current) {
          void attachAndNavigate(element)
          return
        }
        syncSessionAfterAppReady(element)
        markLoaded(element, 'dom-ready')
      }

      // §6.5: transition to crashed on load failure so the overlay doesn't hang
      const onFailLoad = (event: any) => {
        console.warn('[ChatermWebviewHost] did-fail-load', {
          errorCode: event.errorCode,
          errorDescription: event.errorDescription,
          validatedURL: event.validatedURL
        })
        if (event.errorCode !== -3) {
          // -3 is ERR_ABORTED (user-initiated navigation cancel), not a real failure
          setLoadState('crashed')
        }
      }

      // §6.7: block remote navigation — only allow raven-chaterm:// URLs
      const onWillNavigate = (event: any) => {
        if (event.url === BLANK_WEBVIEW_URL || event.url?.startsWith('raven-chaterm://')) {
          return
        }
        if (event.url) {
          event.preventDefault()
          window.api.shell.openExternal(event.url).catch(() => {})
        }
      }

      // §6.9: reverse IPC sent via ipcRenderer.sendToHost() in Chaterm preload
      const onIpcMessage = (event: any) => {
        if (event.channel === IpcChannel.Raven_UI_Navigate && event.args?.[0]) {
          navigate(event.args[0])
          return
        }
        if (event.channel === IpcChannel.Raven_UI_HostWarn) {
          const payload = event.args?.[0] ?? {}
          if (payload?.code === RAVEN_SESSION_HANDOFF_TIMEOUT) {
            markLoaded(element, 'session-handoff-timeout')
          }
          showHostWarning(payload)
        }
      }

      element.addEventListener('did-start-loading', onStartLoading)
      element.addEventListener('did-finish-load', onFinishLoad)
      element.addEventListener('dom-ready', onDomReady)
      element.addEventListener('did-fail-load', onFailLoad)
      element.addEventListener('will-navigate', onWillNavigate)
      element.addEventListener('ipc-message', onIpcMessage)
    },
    // navigate, theme, and notification handlers are captured by closure; they're stable enough
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const handleReload = useCallback(() => {
    resetNavigationState()
    setLoadState('loading')
    const webview = webviewRef.current
    if (!webview) return
    // Loading about:blank triggers dom-ready, which re-runs attachAndNavigate
    // (gated by attachStartedRef, which we just reset above).
    void webview.loadURL(BLANK_WEBVIEW_URL).catch((err) => {
      console.warn('[ChatermWebviewHost] blank reload failed:', err)
    })
  }, [resetNavigationState])

  // Wait for startup to report availability before choosing the terminal.
  if (preloadUrl === undefined) return null
  if (!preloadUrl) return isVisible ? fallback : null

  // §6.4: lazy — only mount the webview once the user first navigates to /terminal
  const shouldMount = everMountedRef.current

  return (
    <>
      {/*
        Native window-drag region for the title-bar strip above the webview.
        On macOS the frameless window (titleBarStyle: 'hidden') reserves a
        `var(--navbar-height)` strip at the top for dragging; other pages fill it
        with a navbar that has `-webkit-app-region: drag`. The Terminal tab renders
        the page as a <webview>, which can't host an app-region and starts below the
        strip — so without this element the strip is empty and the window can't be
        moved while the Terminal tab is active. Skip in fullscreen (no strip) and on
        non-mac platforms (the webview fills from top:0 there).
      */}
      {isVisible && isMac && !isFullscreen && <TitleBarDragRegion />}
      <Host $visible={isVisible} $isFullscreen={isFullscreen}>
        {/* §6.5: loading overlay */}
        {isVisible && (loadState === 'idle' || loadState === 'loading') && (
          <Overlay>
            <LoadingText>{t('terminal.loading', 'Loading Terminal…')}</LoadingText>
          </Overlay>
        )}

        {/* §6.6: crash overlay */}
        {isVisible && loadState === 'crashed' && (
          <Overlay>
            <CrashText>{t('terminal.crashed', 'Terminal crashed')}</CrashText>
            <ReloadButton onClick={handleReload}>{t('terminal.reload', 'Reload')}</ReloadButton>
          </Overlay>
        )}

        {shouldMount && (
          <webview
            ref={setRef}
            src={BLANK_WEBVIEW_URL}
            preload={preloadUrl}
            /* §6.3: no node integration; context isolation on */
            nodeintegration={'false' as any}
            webpreferences="contextIsolation=yes,nodeIntegration=no,additionalArguments=--chaterm-embedded=1"
            allowpopups={'false' as any}
            partition="persist:chaterm"
            style={{
              flex: 1,
              width: '100%',
              height: '100%',
              /* hide webview canvas when crashed; the overlay shows on top */
              display: loadState === 'crashed' ? 'none' : 'flex'
            }}
          />
        )}
      </Host>
    </>
  )
}

// Fills the reserved macOS title-bar strip above the webview so the window stays
// draggable while the Terminal tab is active (the <webview> can't host a drag region).
// Left edge starts after the sidebar to leave room for the native traffic lights.
const TitleBarDragRegion = styled.div`
  position: fixed;
  top: 0;
  left: var(--sidebar-width);
  right: 0;
  height: var(--navbar-height);
  z-index: 100;
  -webkit-app-region: drag;
`

const Host = styled.div<{ $visible: boolean; $isFullscreen: boolean }>`
  display: ${({ $visible }) => ($visible ? 'flex' : 'none')};
  flex-direction: column;
  position: fixed;
  left: var(--sidebar-width);
  /* On Mac account for the native titlebar / drag region; skip in fullscreen */
  top: ${isMac
    ? ({ $isFullscreen }: { $isFullscreen: boolean }) => ($isFullscreen ? '0' : 'var(--navbar-height)')
    : '0'};
  right: 0;
  bottom: 0;
  z-index: 100;
  background-color: var(--color-background);
`

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 10;
  gap: 12px;
  color: var(--color-text-2);
  background-color: var(--color-background);
`

const LoadingText = styled.p`
  font-size: 14px;
  margin: 0;
`

const CrashText = styled.p`
  font-size: 15px;
  color: var(--color-text);
  margin: 0;
`

const ReloadButton = styled.button`
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background-color: var(--color-background-soft);
  color: var(--color-text);
  cursor: pointer;
  font-size: 14px;
  &:hover {
    background-color: var(--color-background-mute);
  }
`

export default ChatermWebviewHost
