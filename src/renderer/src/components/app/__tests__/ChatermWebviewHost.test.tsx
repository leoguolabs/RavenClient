import { IpcChannel } from '@shared/IpcChannel'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ChatermWebviewHost from '../ChatermWebviewHost'

const CHATERM_APP_URL = 'raven-chaterm://app/index.html'
const openNotificationMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/config/constant', () => ({
  isMac: false
}))

vi.mock('@renderer/context/NotificationProvider', () => ({
  useNotification: () => ({
    open: openNotificationMock,
    destroy: vi.fn()
  })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ language: 'en-us' })
}))

vi.mock('@renderer/hooks/useFullscreen', () => ({
  useFullscreen: () => false
}))

vi.mock('@renderer/i18n', () => ({
  default: { language: 'en-us' }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key
  })
}))

let currentUrls = new WeakMap<Element, string>()
const loadUrlMock = vi.fn(async function (this: Element, url: string) {
  currentUrls.set(this, url)
})
const sendMock = vi.fn()
const attachWebviewMock = vi.fn()
const openExternalMock = vi.fn()
const openPathMock = vi.fn()
const logToMainMock = vi.fn()

function renderHost() {
  return render(
    <MemoryRouter initialEntries={['/terminal']}>
      <ChatermWebviewHost fallback={<div>Native terminal</div>} />
    </MemoryRouter>
  )
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function getWebview(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(document.querySelector('webview')).toBeInTheDocument()
  })
  return document.querySelector('webview') as HTMLElement
}

describe('ChatermWebviewHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentUrls = new WeakMap<Element, string>()
    attachWebviewMock.mockResolvedValue(undefined)
    openExternalMock.mockResolvedValue(undefined)
    openPathMock.mockResolvedValue(undefined)
    openNotificationMock.mockClear()

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAppInfo: vi.fn().mockResolvedValue({ logsPath: '/tmp/raven-logs' }),
        openPath: openPathMock,
        logToMain: logToMainMock,
        chaterm: {
          getStatus: vi.fn().mockResolvedValue({
            isEnabled: true,
            hasAssets: true,
            preloadPath: 'file:///tmp/chaterm/preload.js'
          }),
          attachWebview: attachWebviewMock,
          detachWebview: vi.fn(),
          onWebviewCrashed: vi.fn(() => vi.fn()),
          onNavigate: vi.fn(() => vi.fn())
        },
        shell: {
          openExternal: openExternalMock
        }
      }
    })

    Object.assign(HTMLElement.prototype, {
      getWebContentsId: vi.fn(() => 42),
      getURL: function (this: Element) {
        return currentUrls.get(this) ?? this.getAttribute('src') ?? ''
      },
      loadURL: loadUrlMock,
      send: sendMock,
      reload: vi.fn()
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the native terminal when Chaterm resources are unavailable', async () => {
    vi.mocked(window.api.chaterm.getStatus).mockResolvedValueOnce({
      isEnabled: false,
      hasAssets: false,
      preloadPath: ''
    })
    renderHost()

    expect(await screen.findByText('Native terminal')).toBeVisible()
    expect(document.querySelector('webview')).toBeNull()
  })

  it('shows the native terminal when checking Chaterm availability fails', async () => {
    vi.mocked(window.api.chaterm.getStatus).mockRejectedValueOnce(new Error('Status unavailable'))
    renderHost()

    expect(await screen.findByText('Native terminal')).toBeVisible()
    expect(document.querySelector('webview')).toBeNull()
  })

  it('creates the webview at about:blank, attaches on dom-ready, then navigates to Chaterm', async () => {
    renderHost()

    const webview = await getWebview()

    expect(webview.getAttribute('src')).toBe('about:blank')
    expect(webview.getAttribute('webpreferences')).toBe(
      'contextIsolation=yes,nodeIntegration=no,additionalArguments=--chaterm-embedded=1'
    )
    // attach must wait for dom-ready — Electron throws if getWebContentsId is
    // called before the webview is attached + dom-ready has fired.
    expect(attachWebviewMock).not.toHaveBeenCalled()

    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })

    await waitFor(() => expect(attachWebviewMock).toHaveBeenCalledWith(42))
    await waitFor(() => expect(loadUrlMock).toHaveBeenCalledWith(CHATERM_APP_URL))
  })

  it('ignores about:blank dom-ready and marks loaded when Chaterm loadURL resolves', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const attach = createDeferred()
    attachWebviewMock.mockReturnValueOnce(attach.promise)
    renderHost()

    const webview = await getWebview()
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    expect(sendMock).not.toHaveBeenCalled()

    attach.resolve()
    await waitFor(() => expect(loadUrlMock).toHaveBeenCalledWith(CHATERM_APP_URL))

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(IpcChannel.Raven_UI_ThemeChanged, { theme: 'dark' })
      expect(sendMock).toHaveBeenCalledWith(IpcChannel.Raven_UI_LocaleChanged, { locale: 'en-us' })
    })
    expect(infoSpy).toHaveBeenCalledWith('[ChatermWebviewHost] webview loaded via', 'loadURL')
    infoSpy.mockRestore()
  })

  it('marks loaded via did-finish-load before the Chaterm loadURL promise resolves', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const load = createDeferred()
    loadUrlMock.mockImplementationOnce(async function (this: Element, url: string) {
      currentUrls.set(this, url)
      return load.promise
    })
    renderHost()

    const webview = await getWebview()
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    await waitFor(() => expect(loadUrlMock).toHaveBeenCalledWith(CHATERM_APP_URL))
    act(() => {
      webview.dispatchEvent(new Event('did-finish-load'))
    })

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(IpcChannel.Raven_UI_ThemeChanged, { theme: 'dark' })
    })
    expect(infoSpy).toHaveBeenCalledWith('[ChatermWebviewHost] webview loaded via', 'did-finish-load')
    load.resolve()
    await waitFor(() => expect(infoSpy).toHaveBeenCalledTimes(1))
    infoSpy.mockRestore()
  })

  it('does not mark loaded twice when app load events arrive more than once', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    renderHost()

    const webview = await getWebview()
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    await waitFor(() => expect(loadUrlMock).toHaveBeenCalledWith(CHATERM_APP_URL))
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
      webview.dispatchEvent(new Event('did-finish-load'))
    })

    await waitFor(() => expect(infoSpy).toHaveBeenCalledTimes(1))
    expect(attachWebviewMock).toHaveBeenCalledTimes(2)
    infoSpy.mockRestore()
  })

  it('resends the Raven session after the Chaterm app document is ready', async () => {
    renderHost()

    const webview = await getWebview()
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    await waitFor(() => expect(loadUrlMock).toHaveBeenCalledWith(CHATERM_APP_URL))
    expect(attachWebviewMock).toHaveBeenCalledTimes(1)

    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })

    await waitFor(() => expect(attachWebviewMock).toHaveBeenCalledTimes(2))
    expect(attachWebviewMock).toHaveBeenLastCalledWith(42)
  })

  it('keeps the loaded webview visible when later load events start', async () => {
    const { queryByText } = renderHost()

    const webview = await getWebview()
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(IpcChannel.Raven_UI_ThemeChanged, { theme: 'dark' }))
    await waitFor(() => expect(queryByText('Loading Terminal…')).not.toBeInTheDocument())

    act(() => {
      webview.dispatchEvent(new Event('did-start-loading'))
    })

    expect(queryByText('Loading Terminal…')).not.toBeInTheDocument()
  })

  it('treats the embedded session handoff timeout as a non-fatal loaded state', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const attach = createDeferred()
    const load = createDeferred()
    attachWebviewMock.mockReturnValueOnce(attach.promise)
    loadUrlMock.mockImplementationOnce(async function (this: Element, url: string) {
      currentUrls.set(this, url)
      return load.promise
    })
    renderHost()

    const webview = await getWebview()
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    attach.resolve()
    await waitFor(() => expect(loadUrlMock).toHaveBeenCalledWith(CHATERM_APP_URL))

    const event = new Event('ipc-message') as Event & { channel: string; args: unknown[] }
    event.channel = IpcChannel.Raven_UI_HostWarn
    event.args = [{ code: 'raven.session.handoff.timeout', message: 'Terminal 初始化超时' }]

    act(() => {
      webview.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(IpcChannel.Raven_UI_ThemeChanged, { theme: 'dark' })
    })
    expect(infoSpy).toHaveBeenCalledWith('[ChatermWebviewHost] webview loaded via', 'session-handoff-timeout')
    infoSpy.mockRestore()
  })

  it('shows a host warning with a logs action when Chaterm sends raven:ui:host-warn', async () => {
    renderHost()

    const webview = await getWebview()
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    await waitFor(() => expect(loadUrlMock).toHaveBeenCalledWith(CHATERM_APP_URL))

    const event = new Event('ipc-message') as Event & { channel: string; args: unknown[] }
    event.channel = IpcChannel.Raven_UI_HostWarn
    event.args = [{ code: 'chaterm.guest.init.failed', message: 'Terminal 初始化失败' }]

    act(() => {
      webview.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(openNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          message: 'Terminal 初始化失败',
          description: 'chaterm.guest.init.failed'
        })
      )
    })

    const actions = openNotificationMock.mock.calls[0][0].actions
    await act(async () => {
      await actions.props.onClick()
    })
    expect(openPathMock).toHaveBeenCalledWith('/tmp/raven-logs')
  })
})
