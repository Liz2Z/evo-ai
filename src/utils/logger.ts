// Auto-generated
import type { EventEmitter } from 'events'
import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { LogEntry } from '../types'
import type { LogMessageEvent } from '../types/events'
import { getRuntimeDataDir } from '../runtime/paths'

const MAX_BUFFER_SIZE = 500
const LOGS_DIR = join(getRuntimeDataDir(), 'logs')

export class SlaveLogger {
  private buffers: Map<string, LogEntry[]> = new Map()
  private emitter: EventEmitter
  private slaveId: string
  private taskId?: string
  private initialized = false

  constructor(emitter: EventEmitter, slaveId: string, taskId?: string) {
    this.emitter = emitter
    this.slaveId = slaveId
    this.taskId = taskId
  }

  private async ensureDir(): Promise<void> {
    if (!this.initialized) {
      await mkdir(LOGS_DIR, { recursive: true })
      this.initialized = true
    }
  }

  private async write(entry: LogEntry): Promise<void> {
    const key = this.taskId || this.slaveId

    // Ring buffer
    const buffer = this.buffers.get(key) || []
    buffer.push(entry)
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE)
    }
    this.buffers.set(key, buffer)

    // Emit event for TUI
    const event: LogMessageEvent = {
      slaveId: this.slaveId,
      taskId: this.taskId,
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
    }
    this.emitter.emit('log:message', event)

    // Persist to file (non-blocking)
    if (this.taskId) {
      this.persistToFile(this.taskId, entry).catch((err) => {
        // Log persistence failure to stderr but don't throw
        if (entry.level === 'error') {
          // Avoid infinite recursion: only log persistence errors for non-error entries
          process.stderr.write(`[logger] Failed to persist log: ${err}\n`)
        }
      })
    }
  }

  private async persistToFile(taskId: string, entry: LogEntry): Promise<void> {
    await this.ensureDir()
    const filePath = join(LOGS_DIR, `${taskId}.log`)
    await appendFile(filePath, JSON.stringify(entry) + '\n')
  }

  info(message: string): void {
    this.write({
      timestamp: new Date().toISOString(),
      slaveId: this.slaveId,
      taskId: this.taskId,
      level: 'info',
      message,
    })
  }

  error(message: string): void {
    this.write({
      timestamp: new Date().toISOString(),
      slaveId: this.slaveId,
      taskId: this.taskId,
      level: 'error',
      message,
    })
  }

  debug(message: string): void {
    this.write({
      timestamp: new Date().toISOString(),
      slaveId: this.slaveId,
      taskId: this.taskId,
      level: 'debug',
      message,
    })
  }

  setTaskId(taskId: string): void {
    this.taskId = taskId
  }

  getBuffer(taskId?: string): LogEntry[] {
    const key = taskId || this.taskId || this.slaveId
    return this.buffers.get(key) || []
  }
}

// Global log buffer for TUI access without needing a SlaveLogger instance
const globalLogBuffer: Map<string, LogEntry[]> = new Map()

export function getGlobalLogBuffer(): Map<string, LogEntry[]> {
  return globalLogBuffer
}

export function addToGlobalBuffer(taskId: string, entry: LogEntry): void {
  const buffer = globalLogBuffer.get(taskId) || []
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE)
  }
  globalLogBuffer.set(taskId, buffer)
}

/**
 * Simple logger for master and CLI operations
 */
export class Logger {
  private readonly context: string
  private initialized = false

  constructor(context: string) {
    this.context = context
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1)
    return `[${timestamp}] [${this.context}] [${level}] ${message}`
  }

  private async persistToFile(level: string, message: string): Promise<void> {
    try {
      if (!this.initialized) {
        await mkdir(LOGS_DIR, { recursive: true })
        this.initialized = true
      }
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        context: this.context,
        level,
        message,
      }) + '\n'
      await appendFile(join(LOGS_DIR, `${this.context.toLowerCase()}.log`), line)
    } catch {
      // non-critical
    }
  }

  info(message: string): void {
    const formatted = this.formatMessage('INFO', message)
    console.log(formatted)
    void this.persistToFile('info', message)
  }

  error(message: string): void {
    const formatted = this.formatMessage('ERROR', message)
    console.error(formatted)
    void this.persistToFile('error', message)
  }

  warn(message: string): void {
    const formatted = this.formatMessage('WARN', message)
    console.warn(formatted)
    void this.persistToFile('warn', message)
  }

  debug(message: string): void {
    if (process.env.DEBUG) {
      console.log(this.formatMessage('DEBUG', message))
    }
    void this.persistToFile('debug', message)
  }

  /**
   * Output user-facing messages without formatting
   * Used for CLI responses, help text, etc.
   */
  userOutput(message: string): void {
    console.log(message)
  }

  /**
   * Output user-facing errors without formatting
   */
  userError(message: string): void {
    console.error(message)
  }
}
