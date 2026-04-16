import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getRuntimeDataDir } from '../runtime/paths'
import type {
  AgentInfo,
  HistoryEntry,
  ManagerState,
  ManagerUserMessage,
  PersistedEvent,
  Question,
  Task,
} from '../types'

const projectionEmitter = new EventEmitter()

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function todayKey(): string {
  return new Date().toISOString().split('T')[0]
}

async function ensureDir(path: string) {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true })
  }
}

async function appendEvent(
  type: string,
  entityType: PersistedEvent['entityType'],
  payload: Record<string, unknown>,
  entityId?: string,
): Promise<void> {
  const eventsDir = join(getRuntimeDataDir(), 'events')
  await ensureDir(eventsDir)
  const event: PersistedEvent = {
    eventId: generateId('evt'),
    timestamp: new Date().toISOString(),
    type,
    entityType,
    entityId,
    payload,
  }
  const filepath = join(eventsDir, `${todayKey()}.ndjson`)
  await appendFile(filepath, `${JSON.stringify(event)}\n`)
}

function emitProjectionUpdated(scope: string, entityId?: string): void {
  projectionEmitter.emit('projection:updated', {
    scope,
    entityId,
    timestamp: new Date().toISOString(),
  })
}

export function getProjectionEmitter(): EventEmitter {
  return projectionEmitter
}

export async function loadEvents(date: string = todayKey()): Promise<PersistedEvent[]> {
  const filepath = join(getRuntimeDataDir(), 'events', `${date}.ndjson`)
  try {
    const content = await Bun.file(filepath).text()
    if (!content.trim()) return []
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PersistedEvent)
  } catch {
    return []
  }
}

export async function readJSON<T>(filename: string, defaultValue: T): Promise<T> {
  const filepath = join(getRuntimeDataDir(), filename)
  try {
    const content = await Bun.file(filepath).text()
    return JSON.parse(content)
  } catch {
    return defaultValue
  }
}

export async function writeJSON<T>(filename: string, data: T): Promise<void> {
  const filepath = join(getRuntimeDataDir(), filename)
  await ensureDir(dirname(filepath))
  await Bun.write(filepath, JSON.stringify(data, null, 2))
}

async function writeTasksInternal(tasks: Task[]): Promise<void> {
  await writeJSON('tasks.json', tasks)
}

// Tasks storage
export async function loadTasks(): Promise<Task[]> {
  return readJSON('tasks.json', [])
}

export async function saveTasks(tasks: Task[]): Promise<void> {
  await appendEvent('tasks.replaced', 'task', { count: tasks.length })
  await writeTasksInternal(tasks)
  emitProjectionUpdated('tasks')
}

export async function addTask(task: Task): Promise<void> {
  const tasks = await loadTasks()
  tasks.push(task)
  await appendEvent('task.created', 'task', { task }, task.id)
  await writeTasksInternal(tasks)
  emitProjectionUpdated('tasks', task.id)
}

export async function updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
  const tasks = await loadTasks()
  const index = tasks.findIndex((t) => t.id === taskId)
  if (index === -1) return null
  tasks[index] = { ...tasks[index], ...updates, updatedAt: new Date().toISOString() }
  await appendEvent('task.updated', 'task', { updates }, taskId)
  await writeTasksInternal(tasks)
  emitProjectionUpdated('tasks', taskId)
  return tasks[index]
}

export async function getTask(taskId: string): Promise<Task | null> {
  const tasks = await loadTasks()
  return tasks.find((t) => t.id === taskId) || null
}

// Agent storage
export async function loadAgents(): Promise<AgentInfo[]> {
  return readJSON('agents.json', [])
}

export async function saveAgents(agents: AgentInfo[]): Promise<void> {
  await appendEvent('agents.replaced', 'agent', { count: agents.length })
  await writeJSON('agents.json', agents)
  emitProjectionUpdated('agents')
}

export async function updateAgent(agentId: string, updates: Partial<AgentInfo>): Promise<void> {
  const agents = await loadAgents()
  const index = agents.findIndex((agent) => agent.id === agentId)
  if (index !== -1) {
    agents[index] = { ...agents[index], ...updates }
  } else {
    agents.push({ id: agentId, ...updates } as AgentInfo)
  }
  await appendEvent('agent.upserted', 'agent', { updates }, agentId)
  await writeJSON('agents.json', agents)
  emitProjectionUpdated('agents', agentId)
}

// Manager state
export async function loadManagerState(): Promise<ManagerState> {
  return readJSON('manager.json', {
    mission: '',
    currentPhase: 'idle',
    lastHeartbeat: '',
    lastInspection: '',
    activeSince: new Date().toISOString(),
    pendingQuestions: [],
    runtimeMode: 'hybrid',
    lastDecisionAt: '',
    turnStatus: 'idle',
    skippedWakeups: 0,
    currentStage: 'idle',
    pendingUserMessages: [],
  })
}

export async function saveManagerState(state: ManagerState): Promise<void> {
  await appendEvent('manager.updated', 'manager', { state }, 'manager')
  await writeJSON('manager.json', state)
  emitProjectionUpdated('manager', 'manager')
}

export async function enqueueManagerUserMessage(text: string): Promise<ManagerUserMessage> {
  const state = await loadManagerState()
  const message: ManagerUserMessage = {
    id: generateId('manager-msg'),
    text,
    createdAt: new Date().toISOString(),
  }
  state.pendingUserMessages = [...(state.pendingUserMessages || []), message]
  await appendEvent('manager.user_message_queued', 'manager', { message }, 'manager')
  await saveManagerState(state)
  return message
}

// History
export async function loadHistory(date?: string): Promise<HistoryEntry[]> {
  const filename = date
    ? `history/${date}.json`
    : `history/${new Date().toISOString().split('T')[0]}.json`
  return readJSON(filename, [])
}

export async function addHistoryEntry(entry: HistoryEntry): Promise<void> {
  const date = new Date().toISOString().split('T')[0]
  const history = await loadHistory(date)
  history.push(entry)
  await appendEvent('history.added', 'history', { entry }, entry.taskId)
  await writeJSON(`history/${date}.json`, history)
  emitProjectionUpdated('history', entry.taskId)
}

// Failed tasks
export async function loadFailedTasks(): Promise<Task[]> {
  return readJSON('failed_tasks.json', [])
}

export async function addFailedTask(task: Task): Promise<void> {
  const failed = await loadFailedTasks()
  failed.push(task)
  await appendEvent('failed_task.added', 'failed_task', { task }, task.id)
  await writeJSON('failed_tasks.json', failed)
  emitProjectionUpdated('failed_tasks', task.id)
}

// Questions
export async function loadQuestions(): Promise<Question[]> {
  const state = await loadManagerState()
  return state.pendingQuestions
}

export async function addQuestion(question: Question): Promise<void> {
  const state = await loadManagerState()
  state.pendingQuestions.push(question)
  await appendEvent('question.added', 'question', { question }, question.id)
  await saveManagerState(state)
}

export async function answerQuestion(questionId: string, answer: string): Promise<void> {
  const state = await loadManagerState()
  const q = state.pendingQuestions.find((q) => q.id === questionId)
  if (q) {
    q.answered = true
    q.answer = answer
    await appendEvent('question.answered', 'question', { answer }, questionId)
    await saveManagerState(state)
  }
}

// Mission history
export interface MissionHistoryEntry {
  mission: string
  startedAt: string
  endedAt?: string
  worktreeBranch?: string
  worktreePath?: string
  taskCount: number
}

export async function loadMissionHistory(): Promise<MissionHistoryEntry[]> {
  return readJSON('mission_history.json', [])
}

export async function addMissionHistoryEntry(
  entry: Omit<MissionHistoryEntry, 'endedAt'>,
): Promise<void> {
  const history = await loadMissionHistory()
  history.push(entry)
  await writeJSON('mission_history.json', history)
  emitProjectionUpdated('mission_history')
}

export async function updateMissionHistoryEntry(
  mission: string,
  updates: Partial<MissionHistoryEntry>,
): Promise<void> {
  const history = await loadMissionHistory()
  const index = history.findIndex((entry) => entry.mission === mission && !entry.endedAt)
  if (index !== -1) {
    history[index] = { ...history[index], ...updates }
    await writeJSON('mission_history.json', history)
    emitProjectionUpdated('mission_history')
  }
}
