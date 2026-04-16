import { homedir } from 'node:os'
import { join } from 'node:path'
import { xdgConfig } from 'xdg-basedir'

const APP_DIRNAME = '.evo-ai'
const RUNTIME_DIRNAME = '.data'

export function getAppDir(root: string = process.cwd()): string {
  return join(root, APP_DIRNAME)
}

export function getRuntimeDataDir(root: string = process.cwd()): string {
  return join(getAppDir(root), RUNTIME_DIRNAME)
}

export function getRuntimeFilePath(filename: string, root: string = process.cwd()): string {
  return join(getRuntimeDataDir(root), filename)
}

export function getControlFilePath(root: string = process.cwd()): string {
  return getRuntimeFilePath('manager-control.json', root)
}

export function getHealthFilePath(root: string = process.cwd()): string {
  return getRuntimeFilePath('manager-health.json', root)
}

export function getLocalConfigPath(root: string = process.cwd()): string {
  return join(getAppDir(root), 'config.json')
}

export function getLocalCredentialsPath(root: string = process.cwd()): string {
  return join(getAppDir(root), 'credentials.json')
}

export function getXdgConfigDir(): string {
  return xdgConfig || join(homedir(), '.config')
}

export function getGlobalConfigPath(): string {
  return join(getXdgConfigDir(), APP_DIRNAME, 'config.json')
}

export function getGlobalCredentialsPath(): string {
  return join(getXdgConfigDir(), APP_DIRNAME, 'credentials.json')
}
