export type TaskStatus = 'pending' | 'running' | 'reviewing' | 'completed' | 'failed'
export type TaskType = 'fix' | 'feature' | 'refactor' | 'test' | 'docs' | 'other'

export interface ManagerUserMessage {
  id: string
  text: string
  createdAt: string
}

export type ManagerStage =
  | 'idle'
  | 'inspecting'
  | 'working'
  | 'reviewing'
  | 'committing'
  | 'integrating'

export interface Task {
  id: string
  type: TaskType
  status: TaskStatus
  priority: number
  description: string
  context?: string
  createdAt: string
  updatedAt: string
  attemptCount: number
  maxAttempts: number
  reviewHistory: ReviewHistory[]
}

export interface ReviewHistory {
  attempt: number
  agentId: string
  review: ReviewResult
  timestamp: string
}

export type ReviewVerdict = 'approve' | 'request_changes' | 'reject'

export interface ReviewResult {
  taskId: string
  verdict: ReviewVerdict
  confidence: number
  summary: string
  issues: string[]
  suggestions: string[]
}

export type AgentRole = 'inspector' | 'worker' | 'reviewer'
export type AgentStatus = 'idle' | 'busy' | 'offline'

export interface AgentInfo {
  id: string
  type: AgentRole
  status: AgentStatus
  currentTask?: string
  startedAt?: string
  pid?: number
}

export interface TaskResult {
  taskId: string
  status: 'completed' | 'failed'
  summary: string
  filesChanged: string[]
  error?: string
}

export interface ManagerState {
  mission: string
  currentPhase: string
  lastHeartbeat: string
  lastInspection: string
  activeSince: string
  pendingQuestions: Question[]
  runtimeMode: ManagerRuntimeMode
  lastDecisionAt: string
  turnStatus: 'idle' | 'running' | 'paused'
  runtimeSessionSummary?: string
  skippedWakeups: number
  lastSkippedTriggerReason?: string
  missionBranch?: string
  missionWorktree?: string
  currentTaskId?: string
  currentStage: ManagerStage
  pendingUserMessages: ManagerUserMessage[]
}

export interface Question {
  id: string
  question: string
  options: string[]
  createdAt: string
  answered?: boolean
  answer?: string
  source?: string
}

export interface HistoryEntry {
  timestamp: string
  type: 'decision' | 'task_created' | 'task_completed' | 'task_failed' | 'review' | 'error'
  taskId?: string
  agentId?: string
  summary: string
  details?: Record<string, unknown>
}

export interface LogEntry {
  timestamp: string
  agentId: string
  taskId?: string
  source: 'status' | 'agent_text' | 'tool_step'
  level: 'info' | 'error' | 'debug'
  message: string
}

export type { Config } from '../config/schemas'
export type ManagerRuntimeMode = 'heartbeat_agent' | 'session_agent' | 'hybrid'

export interface PersistedEvent {
  eventId: string
  timestamp: string
  type: string
  entityType:
    | 'task'
    | 'agent'
    | 'manager'
    | 'history'
    | 'question'
    | 'config'
    | 'failed_task'
    | 'system'
  entityId?: string
  payload: Record<string, unknown>
}
