import type { EventEmitter } from 'node:events'
import { useEffect, useState } from 'react'
import type { LogEntry } from '../../types'
import type { LogMessageEvent } from '../../types/events'
import {
  appendLogEntry,
  DEFAULT_LOG_LIMIT,
  loadTaskLogs,
  matchesSlaveFilter,
  normalizeSlaveIds,
} from './logStreamModel'

export function useLogStream(
  emitter: EventEmitter | null,
  taskId: string | null,
  slaveIds?: string[],
): LogEntry[] {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const _slaveIdKey = normalizeSlaveIds(slaveIds)?.join(',') || '*'

  useEffect(() => {
    let disposed = false
    const normalizedSlaveIds = normalizeSlaveIds(slaveIds)

    if (!taskId) {
      setEntries([])
      return () => {
        disposed = true
      }
    }

    loadTaskLogs(taskId, normalizedSlaveIds, { limit: DEFAULT_LOG_LIMIT }).then(
      (initialEntries) => {
        if (!disposed) {
          setEntries(initialEntries)
        }
      },
    )

    if (!emitter) {
      return () => {
        disposed = true
      }
    }

    const onLogMessage = (event: LogMessageEvent) => {
      if (event.taskId === taskId) {
        const nextEntry = {
          timestamp: event.timestamp,
          agentId: event.agentId,
          taskId: event.taskId,
          source: event.source,
          level: event.level,
          message: event.message,
        } satisfies LogEntry

        if (!matchesSlaveFilter(nextEntry, normalizedSlaveIds)) {
          return
        }

        setEntries((prev) => appendLogEntry(prev, nextEntry, normalizedSlaveIds, DEFAULT_LOG_LIMIT))
      }
    }

    emitter.on('log:message', onLogMessage)
    return () => {
      disposed = true
      emitter.off('log:message', onLogMessage)
    }
  }, [emitter, taskId, slaveIds])

  return entries
}
