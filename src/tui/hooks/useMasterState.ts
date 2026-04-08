import { useState, useEffect, useCallback } from 'react';
import type { EventEmitter } from 'events';
import type { Task, SlaveInfo, MasterState, LogEntry } from '../../types';
import type {
  HeartbeatTickEvent,
  TaskStatusChangeEvent,
  LogMessageEvent,
  MasterStateEvent,
} from '../../types/events';
import {
  loadTasks,
  loadSlaves,
  loadMasterState as loadState,
  getProjectionEmitter,
} from '../../utils/storage';
import { getGlobalLogBuffer } from '../../utils/logger';

export interface MasterStateData {
  tasks: Task[];
  slaves: SlaveInfo[];
  masterState: MasterState | null;
  selectedTaskId: string | null;
  lastHeartbeat: string;
  phase: string;
  activeSlaves: number;
  pendingCount: number;
  logs: Map<string, LogEntry[]>;
}

export function useMasterState(emitter: EventEmitter | null): MasterStateData & {
  selectTask: (taskId: string | null) => void;
} {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [slaves, setSlaves] = useState<SlaveInfo[]>([]);
  const [masterState, setMasterState] = useState<MasterState | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState('');
  const [phase, setPhase] = useState('initializing');
  const [activeSlaves, setActiveSlaves] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);

  const pollState = useCallback(async () => {
    try {
      const [loadedTasks, loadedSlaves, loadedState] = await Promise.all([
        loadTasks(),
        loadSlaves(),
        loadState(),
      ]);
      setTasks(loadedTasks);
      setSlaves(loadedSlaves);
      setMasterState(loadedState);
      setPhase(loadedState.currentPhase || 'initializing');
      setLastHeartbeat(loadedState.lastHeartbeat || '');
      setActiveSlaves(loadedSlaves.filter(s => s.status === 'busy').length);
      setPendingCount(loadedTasks.filter(t => t.status === 'pending').length);
    } catch {
      // State files may not exist yet
    }
  }, []);

  useEffect(() => {
    // Initial poll
    pollState();

    const projectionEmitter = getProjectionEmitter();
    const onProjectionUpdated = () => {
      pollState();
    };
    projectionEmitter.on('projection:updated', onProjectionUpdated);

    // Poll every 3 seconds as reconciliation
    const pollInterval = setInterval(pollState, 3000);

    return () => {
      clearInterval(pollInterval);
      projectionEmitter.off('projection:updated', onProjectionUpdated);
    };
  }, [pollState]);

  useEffect(() => {
    if (!emitter) return;

    const onHeartbeat = (event: HeartbeatTickEvent) => {
      setLastHeartbeat(event.timestamp);
      setPhase(event.phase);
      setActiveSlaves(event.activeSlaves);
      setPendingCount(event.pendingCount);
    };

    const onTaskChange = (event: TaskStatusChangeEvent) => {
      setTasks(prev =>
        prev.map(t => (t.id === event.taskId ? { ...t, status: event.toStatus } : t))
      );
      // Also refresh from disk on significant changes
      pollState();
    };

    const onMasterState = (event: MasterStateEvent) => {
      setPhase(event.phase);
      setLastHeartbeat(event.lastHeartbeat);
      setMasterState(prev => prev ? { ...prev, currentPhase: event.phase, mission: event.mission, lastHeartbeat: event.lastHeartbeat } : prev);
    };

    const onLogMessage = (event: LogMessageEvent) => {
      if (event.taskId) {
        const buffer = getGlobalLogBuffer();
        const existing = buffer.get(event.taskId) || [];
        buffer.set(event.taskId, [
          ...existing,
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

    emitter.on('heartbeat', onHeartbeat);
    emitter.on('task:status_change', onTaskChange);
    emitter.on('master:state', onMasterState);
    emitter.on('log:message', onLogMessage);

    return () => {
      emitter.off('heartbeat', onHeartbeat);
      emitter.off('task:status_change', onTaskChange);
      emitter.off('master:state', onMasterState);
      emitter.off('log:message', onLogMessage);
    };
  }, [emitter, pollState]);

  return {
    tasks,
    slaves,
    masterState,
    selectedTaskId,
    lastHeartbeat,
    phase,
    activeSlaves,
    pendingCount,
    logs: getGlobalLogBuffer(),
    selectTask: setSelectedTaskId,
  };
}
