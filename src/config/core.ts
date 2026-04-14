// Auto-generated
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { xdgConfig } from 'xdg-basedir'
import type { z } from 'zod'
import { expandEnvVarsInObject } from './env'
import { ConfigError, ValidationError } from './errors'

type ZodObjectLike = z.ZodObject<any>
type Infer<T extends ZodObjectLike> = z.infer<T>

export interface SettingsOptions {
  globalPath?: string
  projectPath?: string
  credentialsPath?: string
  envPrefix?: string
  errorHandling?: 'strict' | 'warn' | 'fallback'
}

function deepMerge(target: any, source: any): any {
  if (!source) return target
  if (!target || typeof target !== 'object') return source

  const result = { ...target }

  for (const key of Object.keys(source)) {
    const targetValue = target[key]
    const sourceValue = source[key]

    if (Array.isArray(sourceValue)) {
      result[key] = sourceValue
    } else if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
      result[key] = deepMerge(targetValue || {}, sourceValue)
    } else {
      result[key] = sourceValue
    }
  }

  return result
}

function parseCLIArgs(appName: string): Record<string, any> {
  const args: Record<string, any> = {}
  const prefix = `--${appName}-`

  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith(prefix)) {
      const parts = arg.slice(prefix.length).split('=')
      const keyPath = parts[0]
      let value: any = parts.slice(1).join('=')

      if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (!Number.isNaN(Number(value)) && value !== '') value = Number(value)

      if (keyPath) {
        const keys = keyPath.split('.')
        let current = args
        for (let i = 0; i < keys.length - 1; i++) {
          const k = keys[i]
          current[k] = current[k] || {}
          current = current[k]
        }
        current[keys[keys.length - 1]] = value
      }
    }
  })
  return args
}

function loadEnvConfig(prefix: string): Record<string, any> {
  const config: Record<string, any> = {}
  const envPrefix = `${prefix.toUpperCase().replace(/-/g, '_')}_`

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(envPrefix) || value === undefined) continue

    const keyPath = key.slice(envPrefix.length).toLowerCase().split('_')
    let current = config

    for (let i = 0; i < keyPath.length - 1; i++) {
      const segment = keyPath[i]
      current[segment] = current[segment] || {}
      current = current[segment]
    }
    current[keyPath[keyPath.length - 1]] = value
  }

  return config
}

/**
 * 嵌套的 Accessor 类型
 */
export type Accessor<T> = {
  get(): T
  get<K extends keyof T>(key: K): T[K]
  set(value: T): void
  set<K extends keyof T>(key: K, value: T[K]): void
  watch(callback: (value: T) => void): () => void
} & (T extends object ? { [K in keyof T]: Accessor<T[K]> } : {})

function createAccessor<T>(
  getData: () => any,
  setData: (path: string[], value: any) => void,
  watchData: (path: string[], callback: (value: any) => void) => () => void,
  path: string[] = [],
): Accessor<T> {
  const target = {
    get(key?: string) {
      const current = getData()
      if (key === undefined) return current
      return current?.[key]
    },
    set(keyOrValue: any, value?: any) {
      if (value !== undefined) {
        setData([...path, keyOrValue], value)
      } else {
        setData(path, keyOrValue)
      }
    },
    watch(callback: (value: any) => void) {
      return watchData(path, callback)
    },
  }

  return new Proxy(target, {
    get(obj: any, prop: string | symbol) {
      if (prop in obj) return obj[prop]

      if (typeof prop === 'string') {
        return createAccessor(() => getData()?.[prop], setData, watchData, [...path, prop])
      }
    },
  }) as Accessor<T>
}

export class Settings<T extends ZodObjectLike> {
  private schema: T
  private appName: string
  private options: SettingsOptions
  private data: Infer<T> | null = null
  private listeners: Set<{ path: string[]; callback: (value: any) => void }> = new Set()
  private accessor: Accessor<Infer<T>> | null = null

  constructor(appName: string, schema: T, options: SettingsOptions = {}) {
    this.appName = appName
    this.schema = schema
    this.options = options
  }

  private getPaths() {
    const configDir = xdgConfig || join(require('os').homedir(), '.config')
    const appDirName = `.${this.appName}`

    const globalSettingsPath = this.options.globalPath ?? join(configDir, appDirName, 'config.json')
    const globalCredentialsPath =
      this.options.credentialsPath ?? join(configDir, appDirName, 'credentials.json')
    const localSettingsPath =
      this.options.projectPath ?? join(process.cwd(), appDirName, 'config.json')
    const localCredentialsPath = join(dirname(localSettingsPath), 'credentials.json')

    return {
      global: globalSettingsPath,
      credentials: globalCredentialsPath,
      local: localSettingsPath,
      localCredentials: localCredentialsPath,
    }
  }

  load(): Accessor<Infer<T>> {
    this.loadData()
    return this.getAccessor()
  }

  private loadData(): void {
    const paths = this.getPaths()
    let merged: any = {}

    // 0. schema 默认值
    try {
      merged = this.schema.parse({})
    } catch (_e) {}

    // 1. 全局配置
    if (existsSync(paths.global)) {
      try {
        const content = JSON.parse(readFileSync(paths.global, 'utf-8'))
        merged = deepMerge(merged, content)
      } catch (_e) {}
    }

    // 2. 全局 Credentials
    if (existsSync(paths.credentials)) {
      try {
        try {
          chmodSync(paths.credentials, 0o600)
        } catch (_e) {}
        const credentials = JSON.parse(readFileSync(paths.credentials, 'utf-8'))
        merged = deepMerge(merged, credentials)
      } catch (_e) {}
    }

    // 3. 本地配置
    if (existsSync(paths.local)) {
      try {
        const content = JSON.parse(readFileSync(paths.local, 'utf-8'))
        merged = deepMerge(merged, content)
      } catch (_e) {}
    }

    // 4. 本地 Credentials
    if (existsSync(paths.localCredentials)) {
      try {
        try {
          chmodSync(paths.localCredentials, 0o600)
        } catch (_e) {}
        const credentials = JSON.parse(readFileSync(paths.localCredentials, 'utf-8'))
        merged = deepMerge(merged, credentials)
      } catch (_e) {}
    }

    // 5. 环境变量
    const envPrefix = this.options.envPrefix ?? this.appName
    const envConfig = loadEnvConfig(envPrefix)
    merged = deepMerge(merged, envConfig)

    // 6. CLI 参数
    const cliConfig = parseCLIArgs(this.appName)
    merged = deepMerge(merged, cliConfig)

    // 环境变量展开
    merged = expandEnvVarsInObject(merged)

    // 校验
    try {
      this.data = this.schema.parse(merged)
    } catch (error: any) {
      if (this.options.errorHandling === 'strict') {
        throw new ValidationError(`配置验证失败: ${error.message}`)
      }
      console.warn(`[Config] 配置验证失败: ${error.message}，使用默认值`)
      this.data = this.schema.parse({})
    }
  }

  getAccessor(): Accessor<Infer<T>> {
    if (!this.accessor) {
      this.accessor = createAccessor<Infer<T>>(
        () => this.data,
        (path, value) => this.setPath(path, value),
        (path, callback) => this.watchPath(path, callback),
      )
    }
    return this.accessor
  }

  get(): Infer<T> {
    if (!this.data) throw new ConfigError('配置未加载')
    return this.data
  }

  private setPath(path: string[], value: any) {
    if (!this.data) throw new ConfigError('配置未加载')

    let current = this.data as any
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]
      if (!(key in current)) {
        current[key] = {}
      }
      current = current[key]
    }

    const lastKey = path[path.length - 1]
    if (lastKey === undefined) {
      this.data = this.schema.parse(value)
    } else {
      current[lastKey] = value
      this.data = this.schema.parse(this.data)
    }

    this.notify(path)
    this.save()
  }

  private notify(changedPath: string[]) {
    for (const listener of this.listeners) {
      const isMatch =
        listener.path.every((p, i) => changedPath[i] === p) ||
        changedPath.every((p, i) => listener.path[i] === p)

      if (isMatch) {
        let value = this.data as any
        for (const p of listener.path) {
          value = value?.[p]
        }
        listener.callback(value)
      }
    }
  }

  private watchPath(path: string[], callback: (value: any) => void) {
    const listener = { path, callback }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  save(): void {
    if (!this.data) return

    const paths = this.getPaths()
    const dir = dirname(paths.global)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    writeFileSync(paths.global, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  getRaw(): Infer<T> | null {
    return this.data
  }
}
