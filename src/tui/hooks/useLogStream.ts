import { useState, useEffect } from 'react';
import type { EventEmitter } from 'events';
import type { LogEntry } from '../../types';
import type { LogMessageEvent } from '../../types/events';
import {
  appendLogEntry,
  DEFAULT_LOG_LIMIT,
  loadTaskLogs,
  matchesSlaveFilter,
  normalizeSlaveIds,
} from './logStreamModel';

export function useLogStream(
  emitter: EventEmitter | null,
  taskId: string | null,
  slaveIds?: string[],
): LogEntry[] {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const normalizedSlaveIds = normalizeSlaveIds(slaveIds);
  const slaveIdKey = normalizedSlaveIds?.join(',') || '*';

  useEffect(() => {
    let disposed = false;

    if (!taskId) {
      setEntries([]);
      return () => {
        disposed = true;
      };
    }

    loadTaskLogs(taskId, normalizedSlaveIds, { limit: DEFAULT_LOG_LIMIT }).then(initialEntries => {
      if (!disposed) {
        setEntries(initialEntries);
      }
    });

    if (!emitter) {
      return () => {
        disposed = true;
      };
    }

    const onLogMessage = (event: LogMessageEvent) => {
      if (event.taskId === taskId) {
        const nextEntry = {
          timestamp: event.timestamp,
          slaveId: event.slaveId,
          taskId: event.taskId,
          level: event.level,
          message: event.message,
        } satisfies LogEntry;

        if (!matchesSlaveFilter(nextEntry, normalizedSlaveIds)) {
          return;
        }

        setEntries(prev => appendLogEntry(prev, nextEntry, normalizedSlaveIds, DEFAULT_LOG_LIMIT));
      }
    };

    emitter.on('log:message', onLogMessage);
    return () => {
      disposed = true;
      emitter.off('log:message', onLogMessage);
    };
  }, [emitter, taskId, slaveIdKey]);

  return entries;
}
