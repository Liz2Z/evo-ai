import type { EventEmitter } from 'node:events'
import { useCallback, useEffect, useState } from 'react'
import type { AgentInfo, LogEntry, ManagerState, Task } from '../../types'
import type {
  HeartbeatTickEvent,
  LogMessageEvent,
  ManagerActivityEvent,
  ManagerStateEvent,
  TaskStatusChangeEvent,
} from '../../types/events'
import { addToGlobalBuffer, getGlobalLogBuffer } from '../../utils/logger'
import {
  getProjectionEmitter,
  loadAgents,
  loadManagerState as loadState,
  loadTasks,
} from '../../utils/storage'
import {
  formatHeartbeatDisplay,
  type MasterActivityItem,
  mergeMasterActivities,
} from '../components/statusBarModel'

export interface MasterStateData {
  tasks: Task[]
  agents: AgentInfo[]
  masterState: ManagerState | null
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
  const [agents, setSlaves] = useState<AgentInfo[]>([])
  const [masterState, setMasterState] = useState<ManagerState | null>(null)
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
        loadAgents(),
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

    const onMasterState = (event: ManagerStateEvent) => {
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
        pendingUserMessages: event.pendingUserMessages,
      })
      refreshHeartbeat(event.phase, event.lastHeartbeat)
    }

    const onLogMessage = (event: LogMessageEvent) => {
      if (event.taskId) {
        addToGlobalBuffer(event.taskId, {
          timestamp: event.timestamp,
          agentId: event.agentId,
          taskId: event.taskId,
          source: event.source,
          level: event.level,
          message: event.message,
        })
      }
    }

    const onMasterActivity = (event: ManagerActivityEvent) => {
      setMasterActivities((existing) => mergeMasterActivities(existing, event))
    }

    emitter.on('heartbeat', onHeartbeat)
    emitter.on('task:status_change', onTaskChange)
    emitter.on('manager:state', onMasterState)
    emitter.on('log:message', onLogMessage)
    emitter.on('manager:activity', onMasterActivity)

    return () => {
      emitter.off('heartbeat', onHeartbeat)
      emitter.off('task:status_change', onTaskChange)
      emitter.off('manager:state', onMasterState)
      emitter.off('log:message', onLogMessage)
      emitter.off('manager:activity', onMasterActivity)
    }
  }, [emitter, pollState, refreshHeartbeat])

  return {
    tasks,
    agents,
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
