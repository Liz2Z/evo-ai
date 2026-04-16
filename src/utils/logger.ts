import type { EventEmitter } from 'node:events'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getRuntimeDataDir } from '../runtime/paths'
import type { LogEntry } from '../types'
import type { LogMessageEvent } from '../types/events'
import { formatBeijingTime, getBeijingTimestamp } from './time'

const MAX_BUFFER_SIZE = 500
const MAX_GLOBAL_TASKS = 100
const LOGS_DIR = join(getRuntimeDataDir(), 'logs')

function logEntryKey(entry: LogEntry): string {
  return [
    entry.timestamp,
    entry.agentId,
    entry.taskId || '',
    entry.source,
    entry.level,
    entry.message,
  ].join('|')
}

export async function appendTaskLog(taskId: string, entry: LogEntry): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true })
  const filePath = join(LOGS_DIR, `${taskId}.log`)
  await appendFile(filePath, `${JSON.stringify(entry)}\n`)
}

export class AgentLogger {
  private buffers: Map<string, LogEntry[]> = new Map()
  private emitter: EventEmitter
  private agentId: string
  private taskId?: string

  constructor(emitter: EventEmitter, agentId: string, taskId?: string) {
    this.emitter = emitter
    this.agentId = agentId
    this.taskId = taskId
  }

  private async write(entry: LogEntry): Promise<void> {
    const key = this.taskId || this.agentId

    // Ring buffer
    const buffer = this.buffers.get(key) || []
    buffer.push(entry)
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE)
    }
    this.buffers.set(key, buffer)

    // Emit event for TUI
    const event: LogMessageEvent = {
      agentId: this.agentId,
      taskId: this.taskId,
      source: entry.source,
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
    }
    this.emitter.emit('log:message', event)

    // Persist to file (non-blocking)
    if (this.taskId) {
      appendTaskLog(this.taskId, entry).catch((err) => {
        // Log persistence failure to stderr but don't throw
        if (entry.level === 'error') {
          // Avoid infinite recursion: only log persistence errors for non-error entries
          process.stderr.write(`[logger] Failed to persist log: ${err}\n`)
        }
      })
    }
  }

  info(message: string, source: LogEntry['source'] = 'status'): void {
    this.write({
      timestamp: getBeijingTimestamp(),
      agentId: this.agentId,
      taskId: this.taskId,
      source,
      level: 'info',
      message,
    })
  }

  error(message: string, source: LogEntry['source'] = 'status'): void {
    this.write({
      timestamp: getBeijingTimestamp(),
      agentId: this.agentId,
      taskId: this.taskId,
      source,
      level: 'error',
      message,
    })
  }

  debug(message: string, source: LogEntry['source'] = 'status'): void {
    this.write({
      timestamp: getBeijingTimestamp(),
      agentId: this.agentId,
      taskId: this.taskId,
      source,
      level: 'debug',
      message,
    })
  }

  setTaskId(taskId: string): void {
    this.taskId = taskId
  }

  getBuffer(taskId?: string): LogEntry[] {
    const key = taskId || this.taskId || this.agentId
    return this.buffers.get(key) || []
  }
}

// Global log buffer for TUI access without needing a AgentLogger instance
const globalLogBuffer: Map<string, LogEntry[]> = new Map()

export function getGlobalLogBuffer(): Map<string, LogEntry[]> {
  return globalLogBuffer
}

function touchGlobalTaskBuffer(taskId: string): void {
  const buffer = globalLogBuffer.get(taskId)
  if (!buffer) return
  globalLogBuffer.delete(taskId)
  globalLogBuffer.set(taskId, buffer)
}

function trimGlobalLogBuffer(): void {
  while (globalLogBuffer.size > MAX_GLOBAL_TASKS) {
    const oldestTaskId = globalLogBuffer.keys().next().value
    if (!oldestTaskId) return
    globalLogBuffer.delete(oldestTaskId)
  }
}

export function getBufferedTaskLogs(taskId: string): LogEntry[] {
  const buffer = globalLogBuffer.get(taskId)
  if (!buffer) return []
  touchGlobalTaskBuffer(taskId)
  return buffer
}

export function addToGlobalBuffer(taskId: string, entry: LogEntry): void {
  const buffer = globalLogBuffer.get(taskId) || []
  const key = logEntryKey(entry)
  if (buffer.some((item) => logEntryKey(item) === key)) {
    touchGlobalTaskBuffer(taskId)
    return
  }
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE)
  }
  globalLogBuffer.set(taskId, buffer)
  touchGlobalTaskBuffer(taskId)
  trimGlobalLogBuffer()
}

export function clearTaskLogBuffer(taskId: string): void {
  globalLogBuffer.delete(taskId)
}

/**
 * Simple logger for manager and CLI operations
 */
export class Logger {
  private readonly context: string
  private initialized = false

  constructor(context: string) {
    this.context = context
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = formatBeijingTime(new Date(), { withMilliseconds: true })
    return `[${timestamp}] [${this.context}] [${level}] ${message}`
  }

  private async persistToFile(level: string, message: string): Promise<void> {
    try {
      if (!this.initialized) {
        await mkdir(LOGS_DIR, { recursive: true })
        this.initialized = true
      }
      const line = `${JSON.stringify({
        timestamp: getBeijingTimestamp(),
        context: this.context,
        level,
        message,
      })}\n`
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
