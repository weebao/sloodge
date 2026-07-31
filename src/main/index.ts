import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'
import { installAppMenu } from './menu/appMenu'
import { isAllowedNavigation, toSafeExternalUrl } from './security/externalUrls'

const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const rendererDistIndexUrl = new URL('../renderer/index.html', import.meta.url)
const rendererDistIndex = fileURLToPath(rendererDistIndexUrl)

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  // Never let the shell navigate away or spawn windows; web/mail links open in
  // the OS browser, anything else (file:, custom schemes, …) is dropped.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = toSafeExternalUrl(url)
    if (safeUrl !== null) {
      shell.openExternal(safeUrl).catch(() => {
        // The OS refused (no handler, user policy, …); nothing to clean up.
      })
    }
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  const appUrl =
    devServerUrl !== undefined && devServerUrl !== '' ? devServerUrl : rendererDistIndexUrl.href

  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, appUrl)) {
      event.preventDefault()
    }
  })

  if (devServerUrl !== undefined && devServerUrl !== '') {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(rendererDistIndex)
  }

  return window
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    installAppMenu()
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
