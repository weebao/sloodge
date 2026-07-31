import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'
import { installAppMenu } from './menu/appMenu'
import { isAllowedNavigation, toSafeExternalUrl } from './security/externalUrls'
import { installSlideProtocol, registerSlideSchemePrivileges } from './slide/protocol'

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

  // A slide navigating *itself* off `slide://` would be an exfiltration channel — deck content in a
  // query string, then an attacker-authored page rendered inside the app window. It is closed, but
  // not here: the **embedder's `frame-src`** governs every navigation of a child frame, not merely
  // its initial `src`, so `src/renderer/index.html`'s `frame-src blob: slide:` blocks it in the
  // renderer before any request is made. Measured — see the note in 10-architecture.md §7.
  //
  // An Electron-side `will-frame-navigate` guard was written for this and then deleted, because it
  // provably does not fire for a renderer-initiated subframe navigation on Electron 43: the event
  // was emitted for the frame's initial `slide://` load and not for its subsequent `http://` one,
  // while `did-start-navigation` saw both. Keeping a guard that never runs would have made the
  // real mechanism harder to find, not easier.

  if (devServerUrl !== undefined && devServerUrl !== '') {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(rendererDistIndex)
  }

  return window
}

// Module scope, not inside the ready handler: `registerSchemesAsPrivileged` throws once the app is
// ready, because Chromium reads the scheme registry during renderer startup and never re-reads it.
registerSlideSchemePrivileges()

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    installAppMenu()
    const slideRegistry = installSlideProtocol()
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })

    // Published slide documents are released by the renderer's per-frame effect cleanups, but a
    // window that closes never runs them: the whole renderer goes away mid-flight and every
    // document it published stays in main's heap. On macOS the process survives that and can be
    // reactivated, so without this a close/reopen cycle would accumulate a deck's worth of HTML
    // each time. Safe unconditionally — the next window republishes everything it renders.
    app.on('window-all-closed', () => {
      slideRegistry.clear()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
