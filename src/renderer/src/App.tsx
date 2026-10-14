import '@renderer/databases'

import { loggerService } from '@logger'
import { initializeDefaultMinApps } from '@renderer/config/minapps'
import store, { persistor, useAppDispatch, useAppSelector } from '@renderer/store'
import { initializeMCPServers } from '@renderer/store/mcp'
import { resetSidebarIcons } from '@renderer/store/settings'
import React, { useEffect } from 'react'
import { Provider } from 'react-redux'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { PersistGate } from 'redux-persist/integration/react'

import ChatermWebviewHost from './components/app/ChatermWebviewHost'
import Sidebar from './components/app/Sidebar'
import RavenAccountGate from './components/auth/RavenAccountGate'
import TopViewContainer from './components/TopView'
import AntdProvider from './context/AntdProvider'
import { CodeStyleProvider } from './context/CodeStyleProvider'
import { NotificationProvider } from './context/NotificationProvider'
import { RavenAccountProvider } from './context/RavenAccountContext'
import StyleSheetManager from './context/StyleSheetManager'
import { ThemeProvider } from './context/ThemeProvider'
import NavigationHandler from './handler/NavigationHandler'
import { CHATERM_TERMINAL_ENABLED } from './config/terminalFlags'
import AgentsPage from './pages/agents/AgentsPage'
import FilesPage from './pages/files/FilesPage'
import HomePage from './pages/home/HomePage'
import KnowledgePage from './pages/knowledge/KnowledgePage'
import PackagerPage from './pages/Packager/Packager'
import SettingsPage from './pages/settings/SettingsPage'
import TerminalPage from './pages/terminal/TerminalPage'

const logger = loggerService.withContext('App')

// 初始化组件
function AppInitializer() {
  const dispatch = useAppDispatch()
  const mcpServers = useAppSelector((state) => state.mcp.servers)

  useEffect(() => {
    // 在应用启动时初始化自定义小应用
    initializeDefaultMinApps().catch((error) =>
      loggerService.error('Failed to initialize default mini apps:', error as Error)
    )
    // 重置侧边栏图标以确保新图标可见
    dispatch(resetSidebarIcons())
    // 初始化内置MCP服务器
    initializeMCPServers(mcpServers, dispatch)
  }, [dispatch, mcpServers])

  return null
}

function App(): React.ReactElement {
  logger.info('App initialized')

  return (
    <Provider store={store}>
      <StyleSheetManager>
        <ThemeProvider>
          <AntdProvider>
            <NotificationProvider>
              <CodeStyleProvider>
                <PersistGate loading={null} persistor={persistor}>
                  <RavenAccountProvider>
                    <RavenAccountGate>
                      <AppInitializer />
                      <TopViewContainer>
                        <HashRouter>
                          <NavigationHandler />
                          <Sidebar />
                          <React.Suspense fallback={<div>Loading...</div>}>
                            <Routes>
                              <Route path="/" element={<HomePage />} />
                              <Route path="/agents" element={<AgentsPage />} />
                              <Route path="/files" element={<FilesPage />} />
                              <Route path="/knowledge" element={<KnowledgePage />} />
                              <Route path="/packager/*" element={<PackagerPage />} />
                              <Route path="/settings/*" element={<SettingsPage />} />
                              {/* §6.1/6.2: Terminal tab — ChatermWebviewHost renders the webview */}
                              <Route path="/terminal" element={<TerminalPage />} />
                            </Routes>
                          </React.Suspense>
                          {/* §6.4: Persistent webview host outside Routes keeps SSH sessions alive.
                              Dormant while the native terminal owns the /terminal tab. */}
                          {CHATERM_TERMINAL_ENABLED && <ChatermWebviewHost />}
                        </HashRouter>
                      </TopViewContainer>
                    </RavenAccountGate>
                  </RavenAccountProvider>
                </PersistGate>
              </CodeStyleProvider>
            </NotificationProvider>
          </AntdProvider>
        </ThemeProvider>
      </StyleSheetManager>
    </Provider>
  )
}

export default App
