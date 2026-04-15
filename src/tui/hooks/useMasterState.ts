import type { EventEmitter } from 'node:events'
import { useCallback, useEffect, useState } from 'react'
import type { LogEntry, MasterState, SlaveInfo, Task } from '../../types'
import type {
  HeartbeatTickEvent,
  LogMessageEvent,
  MasterActivityEvent,
  MasterStateEvent,
  TaskStatusChangeEvent,
} from '../../types/events'
import { addToGlobalBuffer, getGlobalLogBuffer } from '../../utils/logger'
import {
  getProjectionEmitter,
  loadSlaves,
  loadMasterState as loadState,
  loadTasks,
} from '../../utils/storage'
import {
  formatHeartbeatDisplay,
  type MasterActivityItem,
  mergeMasterActivities,
} from '../components/statusBarModel'

export interface MasterStateData {
  tasks: Task[]
  slaves: SlaveInfo[]
  masterState: MasterState | null
  selectedTaskId: string | null
  lastHeartbeat: string
  phase: string
  heartbeatIntervalMs: number
  heartbeatRemainingMs: number
  heartbeatDisplay: string
  masterActivities: MasterActivityItem[]
  logs: Map<string, LogEntry[]>
}

export function useMasterState(
  emitter: EventEmitter | null,
  heartbeatIntervalMs: number,
): MasterStateData & {
  selectTask: (taskId: string | null) => void
} {
  const [tasks, setTasks] = useState<Task[]>([])
  const [slaves, setSlaves] = useState<SlaveInfo[]>([])
  const [masterState, setMasterState] = useState<MasterState | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [lastHeartbeat, setLastHeartbeat] = useState('')
  const [phase, setPhase] = useState('initializing')
  const [heartbeatRemainingMs, setHeartbeatRemainingMs] = useState(heartbeatIntervalMs)
  const [heartbeatDisplay, setHeartbeatDisplay] = useState(
    `--/${Math.ceil(heartbeatIntervalMs / 1000)}s`,
  )
  const [masterActivities, setMasterActivities] = useState<MasterActivityItem[]>([])

  const pollState = useCallback(async () => {
    try {
      const [loadedTasks, loadedSlaves, loadedState] = await Promise.all([
        loadTasks(),
        loadSlaves(),
        loadState(),
      ])
      setTasks(loadedTasks)
      setSlaves(loadedSlaves)
      setMasterState(loadedState)
      setPhase(loadedState.currentPhase || 'initializing')
      setLastHeartbeat(loadedState.lastHeartbeat || '')
    } catch {}
  }, [])

  const refreshHeartbeat = useCallback(
    (currentPhase: string, heartbeatAt: string) => {
      const next = formatHeartbeatDisplay({
        phase: currentPhase,
        lastHeartbeat: heartbeatAt,
        heartbeatIntervalMs,
      })
      setHeartbeatRemainingMs(next.remainingMs)
      setHeartbeatDisplay(next.display)
    },
    [heartbeatIntervalMs],
  )

  useEffect(() => {
    pollState()
    const projectionEmitter = getProjectionEmitter()
    const onProjectionUpdated = () => {
      pollState()
    }
    projectionEmitter.on('projection:updated', onProjectionUpdated)
    const pollInterval = setInterval(pollState, 3000)

    return () => {
      clearInterval(pollInterval)
      projectionEmitter.off('projection:updated', onProjectionUpdated)
    }
  }, [pollState])

  useEffect(() => {
    refreshHeartbeat(phase, lastHeartbeat)
    const interval = setInterval(() => {
      refreshHeartbeat(phase, lastHeartbeat)
    }, 1000)

    return () => {
      clearInterval(interval)
    }
  }, [phase, lastHeartbeat, refreshHeartbeat])

  useEffect(() => {
    if (!emitter) return

    const onHeartbeat = (event: HeartbeatTickEvent) => {
      setLastHeartbeat(event.timestamp)
      setPhase(event.phase)
      refreshHeartbeat(event.phase, event.timestamp)
    }

    const onTaskChange = (_event: TaskStatusChangeEvent) => {
      pollState()
    }

    const onMasterState = (event: MasterStateEvent) => {
      setPhase(event.phase)
      setLastHeartbeat(event.lastHeartbeat)
      setMasterState({
        mission: event.mission,
        currentPhase: event.phase,
        lastHeartbeat: event.lastHeartbeat,
        lastInspection: event.lastInspection,
        activeSince: event.activeSince,
        pendingQuestions: event.pendingQuestions,
        runtimeMode: event.runtimeMode,
        lastDecisionAt: event.lastDecisionAt,
        turnStatus: event.turnStatus,
        runtimeSessionSummary: event.runtimeSessionSummary,
        skippedWakeups: event.skippedWakeups,
        lastSkippedTriggerReason: event.lastSkippedTriggerReason,
        missionBranch: event.missionBranch,
        missionWorktree: event.missionWorktree,
        currentTaskId: event.currentTaskId,
        currentStage: event.currentStage,
      })
      refreshHeartbeat(event.phase, event.lastHeartbeat)
    }

    const onLogMessage = (event: LogMessageEvent) => {
      if (event.taskId) {
        addToGlobalBuffer(event.taskId, {
          timestamp: event.timestamp,
          slaveId: event.slaveId,
          taskId: event.taskId,
          source: event.source,
          level: event.level,
          message: event.message,
        })
      }
    }

    const onMasterActivity = (event: MasterActivityEvent) => {
      setMasterActivities((existing) => mergeMasterActivities(existing, event))
    }

    emitter.on('heartbeat', onHeartbeat)
    emitter.on('task:status_change', onTaskChange)
    emitter.on('master:state', onMasterState)
    emitter.on('log:message', onLogMessage)
    emitter.on('master:activity', onMasterActivity)

    return () => {
      emitter.off('heartbeat', onHeartbeat)
      emitter.off('task:status_change', onTaskChange)
      emitter.off('master:state', onMasterState)
      emitter.off('log:message', onLogMessage)
      emitter.off('master:activity', onMasterActivity)
    }
  }, [emitter, pollState, refreshHeartbeat])

  return {
    tasks,
    slaves,
    masterState,
    selectedTaskId,
    lastHeartbeat,
    phase,
    heartbeatIntervalMs,
    heartbeatRemainingMs,
    heartbeatDisplay,
    masterActivities,
    logs: getGlobalLogBuffer(),
    selectTask: setSelectedTaskId,
  }
}
