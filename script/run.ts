import { join } from 'path'
import { spawn, SpawnOptions } from 'child_process'
import * as Fs from 'fs'
import { getDistPath, getExecutableName } from './dist-info'

const distPath = getDistPath()
const productName = getExecutableName()

let binaryPath = ''
if (process.platform === 'darwin') {
  binaryPath = join(
    distPath,
    `${productName}.app`,
    'Contents',
    'MacOS',
    `${productName}`
  )
} else if (process.platform === 'win32') {
  binaryPath = join(distPath, `${productName}.exe`)
} else if (process.platform === 'linux') {
  binaryPath = join(distPath, productName)
} else {
  console.error(`I dunno how to run on ${process.platform} ${process.arch} :(`)
  process.exit(1)
}

export function run(spawnOptions: SpawnOptions) {
  try {
    // eslint-disable-next-line no-sync
    const stats = Fs.statSync(binaryPath)
    if (!stats.isFile()) {
      return null
    }
  } catch (e) {
    return null
  }

  const opts = Object.assign({}, spawnOptions)

  opts.env = Object.assign(opts.env || {}, process.env, {
    NODE_ENV: 'development',
  })

  // Force X11 (XWayland) on Linux: the native Wayland backend mis-renders the
  // window frame and drops the in-window menu bar under KDE. Passed as a hard
  // `--ozone-platform` switch rather than the softer ELECTRON_OZONE_PLATFORM_HINT
  // env var, which Electron's auto-detection can still override. Chromium
  // consumes the flag before app code, so it never reaches our argv parsing.
  const args = process.platform === 'linux' ? ['--ozone-platform=x11'] : []

  return spawn(binaryPath, args, opts)
}
