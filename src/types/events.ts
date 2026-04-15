import type {
  MasterRuntimeMode,
  MasterStage,
  MasterState,
  Question,
  SlaveStatus,
  SlaveType,
  Task,
  TaskStatus,
} from './index'

export type EvoEventType =
  | 'heartbeat'
  | 'task:status_change'
  | 'slave:status_change'
  | 'log:message'
  | 'worktree:change'
  | 'master:state'
  | 'projection:updated'

export interface HeartbeatTickEvent {
  timestamp: string
  phase: string
  activeSlaves: number
  pendingCount: number
}

export interface TaskStatusChangeEvent {
  taskId: string
  fromStatus: TaskStatus
  toStatus: TaskStatus
  task: Task
}

export interface SlaveStatusChangeEvent {
  slaveId: string
  type: SlaveType
  fromStatus: SlaveStatus
  toStatus: SlaveStatus
  currentTask?: string
}

export interface LogMessageEvent {
  slaveId: string
  taskId?: string
  source: 'status' | 'agent_text' | 'tool_step'
  level: 'info' | 'error' | 'debug'
  message: string
  timestamp: string
}

export interface WorktreeChangeEvent {
  mission: string
  action: 'created' | 'removed'
  path: string
  branch?: string
}

export interface MasterStateEvent {
  phase: string
  mission: string
  lastHeartbeat: string
  lastInspection: string
  activeSince: string
  pendingQuestions: Question[]
  runtimeMode: MasterRuntimeMode
  turnStatus: MasterState['turnStatus']
  lastDecisionAt: string
  runtimeSessionSummary?: string
  skippedWakeups: number
  lastSkippedTriggerReason?: string
  missionBranch?: string
  missionWorktree?: string
  currentTaskId?: string
  currentStage: MasterStage
}

export interface ProjectionUpdatedEvent {
  scope: string
  entityId?: string
  timestamp: string
}

export type EvoEvent =
  | HeartbeatTickEvent
  | TaskStatusChangeEvent
  | SlaveStatusChangeEvent
  | LogMessageEvent
  | WorktreeChangeEvent
  | MasterStateEvent
  | ProjectionUpdatedEvent
