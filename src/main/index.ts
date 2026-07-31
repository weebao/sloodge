import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'
import { installAppMenu } from './menu/appMenu'

const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const rendererDistIndex = fileURLToPath(new URL('../renderer/index.html', import.meta.url))

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

  // Never let the shell navigate away or spawn windows; open externals in the OS browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
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
