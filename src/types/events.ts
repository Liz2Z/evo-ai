import type {
  AgentRole,
  AgentStatus,
  ManagerRuntimeMode,
  ManagerStage,
  ManagerState,
  ManagerUserMessage,
  Question,
  Task,
  TaskStatus,
} from './index'

export type EvoEventType =
  | 'heartbeat'
  | 'task:status_change'
  | 'agent:status_change'
  | 'log:message'
  | 'worktree:change'
  | 'manager:state'
  | 'manager:activity'
  | 'projection:updated'

export interface HeartbeatTickEvent {
  timestamp: string
  phase: string
  activeAgents: number
  pendingCount: number
}

export interface TaskStatusChangeEvent {
  taskId: string
  fromStatus: TaskStatus
  toStatus: TaskStatus
  task: Task
}

export interface AgentStatusChangeEvent {
  agentId: string
  role: AgentRole
  fromStatus: AgentStatus
  toStatus: AgentStatus
  currentTask?: string
}

export interface LogMessageEvent {
  agentId: string
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

export interface ManagerStateEvent {
  phase: string
  mission: string
  lastHeartbeat: string
  lastInspection: string
  activeSince: string
  pendingQuestions: Question[]
  runtimeMode: ManagerRuntimeMode
  turnStatus: ManagerState['turnStatus']
  lastDecisionAt: string
  runtimeSessionSummary?: string
  skippedWakeups: number
  lastSkippedTriggerReason?: string
  missionBranch?: string
  missionWorktree?: string
  currentTaskId?: string
  currentStage: ManagerStage
  pendingUserMessages: ManagerUserMessage[]
}

export interface ManagerActivityEvent {
  timestamp: string
  triggerReason: string
  summary: string
  toolCalls: string[]
  kind: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_skipped' | 'turn_interrupted'
}

export interface ProjectionUpdatedEvent {
  scope: string
  entityId?: string
  timestamp: string
}

export type EvoEvent =
  | HeartbeatTickEvent
  | TaskStatusChangeEvent
  | AgentStatusChangeEvent
  | LogMessageEvent
  | WorktreeChangeEvent
  | ManagerStateEvent
  | ManagerActivityEvent
  | ProjectionUpdatedEvent
