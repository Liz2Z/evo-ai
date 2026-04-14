// Auto-generated
import type { EventEmitter } from 'events'
import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { LogEntry } from '../types'
import type { LogMessageEvent } from '../types/events'

const MAX_BUFFER_SIZE = 500
const LOGS_DIR = join(process.cwd(), 'data', 'logs')

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
