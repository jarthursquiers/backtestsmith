import { join } from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import { createLogger } from '../../services/logger.js'
import { registerIpcHandlers } from './ipc.js'
import { disposeServices, initServices } from './services.js'

const log = createLogger('main')

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    // Matches the dark theme so launch does not flash white.
    backgroundColor: '#0b0f16',
    title: 'Backtestsmith',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // The renderer must never touch Node or Massive directly; everything
      // goes through the audited preload bridge.
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => window.show())

  // External links open in the real browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.backtestsmith.app')

  // Opening the database is async, so the window is created only once the
  // cache is ready and the renderer cannot query a half-initialized store.
  await initServices()
  registerIpcHandlers(() => mainWindow)

  mainWindow = createWindow()
  log.info('application ready', { version: app.getVersion(), platform: process.platform })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
}).catch((error: unknown) => {
  log.error('failed to start', { error: error instanceof Error ? error.message : String(error) })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void disposeServices()
})

process.on('uncaughtException', (error) => {
  log.error('uncaught exception', { error: error.message, stack: error.stack })
})

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) })
})
