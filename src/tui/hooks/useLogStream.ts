import { useState, useEffect } from 'react';
import type { EventEmitter } from 'events';
import type { LogEntry } from '../../types';
import type { LogMessageEvent } from '../../types/events';
import { getGlobalLogBuffer } from '../../utils/logger';

export function useLogStream(
  emitter: EventEmitter | null,
  taskId: string | null
): LogEntry[] {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (!taskId) {
      setEntries([]);
      return;
    }

    // Load existing buffer
    const buffer = getGlobalLogBuffer();
    const existing = buffer.get(taskId) || [];
    setEntries(existing);

    if (!emitter) return;

    const onLogMessage = (event: LogMessageEvent) => {
      if (event.taskId === taskId) {
        setEntries(prev => [
          ...prev,
          {
            timestamp: event.timestamp,
            slaveId: event.slaveId,
            taskId: event.taskId,
            level: event.level,
            message: event.message,
          },
        ]);
      }
    };

    emitter.on('log:message', onLogMessage);
    return () => {
      emitter.off('log:message', onLogMessage);
    };
  }, [emitter, taskId]);

  return entries;
}
