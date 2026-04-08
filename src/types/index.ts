// Task types
export type TaskStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'reviewing' | 'approved' | 'rejected';
export type TaskType = 'fix' | 'feature' | 'refactor' | 'test' | 'docs' | 'other';

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  description: string;
  context?: string;
  createdAt: string;
  updatedAt: string;
  assignedTo?: string;
  worktree?: string;
  branch?: string;
  attemptCount: number;
  maxAttempts: number;
  reviewHistory: ReviewHistory[];
}

export interface ReviewHistory {
  attempt: number;
  slaveId: string;
  review: ReviewResult;
  timestamp: string;
}

// Review types
export type ReviewVerdict = 'approve' | 'request_changes' | 'reject';

export interface ReviewResult {
  taskId: string;
  verdict: ReviewVerdict;
  confidence: number;
  summary: string;
  issues: string[];
  suggestions: string[];
}

// Slave types
export type SlaveType = 'inspector' | 'worker' | 'reviewer';
export type SlaveStatus = 'idle' | 'busy' | 'offline';

export interface SlaveInfo {
  id: string;
  type: SlaveType;
  status: SlaveStatus;
  currentTask?: string;
  startedAt?: string;
  pid?: number;
}

// Task result from Slave
export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed';
  worktree: string;
  branch: string;
  diff: string;
  summary: string;
  filesChanged: string[];
  error?: string;
}

// Master state
export interface MasterState {
  mission: string;
  currentPhase: string;
  lastHeartbeat: string;
  lastInspection: string;
  activeSince: string;
  pendingQuestions: Question[];
}

// Question for human
export interface Question {
  id: string;
  question: string;
  options: string[];
  createdAt: string;
  answered?: boolean;
  answer?: string;
}

// History entry
export interface HistoryEntry {
  timestamp: string;
  type: 'decision' | 'task_created' | 'task_completed' | 'task_failed' | 'review' | 'merge' | 'error';
  taskId?: string;
  slaveId?: string;
  summary: string;
  details?: Record<string, unknown>;
}

// Log entry
export interface LogEntry {
  timestamp: string;
  slaveId: string;
  taskId?: string;
  level: 'info' | 'error' | 'debug';
  message: string;
}

// Config
export type ModelTier = 'lite' | 'pro' | 'max';

export interface ModelTierConfig {
  lite: string;
  pro: string;
  max: string;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface Config {
  heartbeatInterval: number;
  maxConcurrency: number;
  maxRetryAttempts: number;
  worktreesDir: string;
  developBranch: string;
  models: ModelTierConfig;
  provider: ProviderConfig;
}

// Persisted event log entry (append-only)
export interface PersistedEvent {
  eventId: string;
  timestamp: string;
  type: string;
  entityType: 'task' | 'slave' | 'master' | 'history' | 'question' | 'config' | 'failed_task' | 'system';
  entityId?: string;
  payload: Record<string, unknown>;
}
