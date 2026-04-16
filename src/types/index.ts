export type TaskStatus = 'pending' | 'running' | 'reviewing' | 'completed' | 'failed'
export type TaskType = 'fix' | 'feature' | 'refactor' | 'test' | 'docs' | 'other'
export type MasterStage =
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
  slaveId: string
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

export type SlaveType = 'inspector' | 'worker' | 'reviewer'
export type SlaveStatus = 'idle' | 'busy' | 'offline'

export interface SlaveInfo {
  id: string
  type: SlaveType
  status: SlaveStatus
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

export interface MasterState {
  mission: string
  currentPhase: string
  lastHeartbeat: string
  lastInspection: string
  activeSince: string
  pendingQuestions: Question[]
  runtimeMode: MasterRuntimeMode
  lastDecisionAt: string
  turnStatus: 'idle' | 'running' | 'paused'
  runtimeSessionSummary?: string
  skippedWakeups: number
  lastSkippedTriggerReason?: string
  missionBranch?: string
  missionWorktree?: string
  currentTaskId?: string
  currentStage: MasterStage
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
  slaveId?: string
  summary: string
  details?: Record<string, unknown>
}

export interface LogEntry {
  timestamp: string
  slaveId: string
  taskId?: string
  source: 'status' | 'agent_text' | 'tool_step'
  level: 'info' | 'error' | 'debug'
  message: string
}

export type { Config } from '../config/schemas'
export type ModelTier = 'lite' | 'pro' | 'max'
export type MasterRuntimeMode = 'heartbeat_agent' | 'session_agent' | 'hybrid'

export interface PersistedEvent {
  eventId: string
  timestamp: string
  type: string
  entityType:
    | 'task'
    | 'slave'
    | 'master'
    | 'history'
    | 'question'
    | 'config'
    | 'failed_task'
    | 'system'
  entityId?: string
  payload: Record<string, unknown>
}
