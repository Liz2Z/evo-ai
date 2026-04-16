import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getRuntimeDataDir } from '../../runtime/paths'
import type { LogEntry } from '../../types'
import { getBufferedTaskLogs } from '../../utils/logger'
import { getTimestampValue } from '../../utils/time'

export const DEFAULT_LOG_LIMIT = 200

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

export function normalizeSlaveIds(slaveIds?: string[]): string[] | undefined {
  if (!slaveIds) return undefined
  return [...new Set(slaveIds)].sort()
}

export function matchesSlaveFilter(entry: LogEntry, slaveIds?: string[]): boolean {
  if (!slaveIds) return true
  if (slaveIds.length === 0) return false
  return slaveIds.includes(entry.agentId)
}

export function parseLogFileContent(content: string): LogEntry[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<LogEntry>
        if (
          typeof parsed.timestamp !== 'string' ||
          typeof parsed.agentId !== 'string' ||
          typeof parsed.level !== 'string' ||
          typeof parsed.message !== 'string'
        ) {
          return []
        }
        return [
          {
            timestamp: parsed.timestamp,
            agentId: parsed.agentId,
            taskId: parsed.taskId,
            source: parsed.source || 'status',
            level: parsed.level as LogEntry['level'],
            message: parsed.message,
          } satisfies LogEntry,
        ]
      } catch {
        return []
      }
    })
}

export function mergeLogEntries(
  sources: LogEntry[][],
  slaveIds?: string[],
  limit = DEFAULT_LOG_LIMIT,
): LogEntry[] {
  const merged = new Map<string, LogEntry>()

  for (const source of sources) {
    for (const entry of source) {
      if (!matchesSlaveFilter(entry, slaveIds)) continue
      merged.set(logEntryKey(entry), entry)
    }
  }

  return [...merged.values()]
    .sort((a, b) => {
      const timeDiff = getTimestampValue(a.timestamp) - getTimestampValue(b.timestamp)
      return timeDiff !== 0 ? timeDiff : a.timestamp.localeCompare(b.timestamp)
    })
    .slice(-limit)
}

export function appendLogEntry(
  existing: LogEntry[],
  entry: LogEntry,
  slaveIds?: string[],
  limit = DEFAULT_LOG_LIMIT,
): LogEntry[] {
  return mergeLogEntries([existing, [entry]], slaveIds, limit)
}

export async function readPersistedTaskLogs(
  taskId: string,
  logsDir = join(getRuntimeDataDir(), 'logs'),
): Promise<LogEntry[]> {
  try {
    const filepath = join(logsDir, `${taskId}.log`)
    const content = await readFile(filepath, 'utf-8')
    return parseLogFileContent(content)
  } catch {
    return []
  }
}

export async function loadTaskLogs(
  taskId: string,
  slaveIds?: string[],
  options?: {
    limit?: number
    logsDir?: string
  },
): Promise<LogEntry[]> {
  const inMemory = getBufferedTaskLogs(taskId)
  const fromDisk = await readPersistedTaskLogs(taskId, options?.logsDir)

  return mergeLogEntries([inMemory, fromDisk], slaveIds, options?.limit ?? DEFAULT_LOG_LIMIT)
}
