import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getRuntimeDataDir } from '../runtime/paths'
import type { HistoryEntry, MasterState, PersistedEvent, Question, SlaveInfo, Task } from '../types'

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

// Slave storage
export async function loadSlaves(): Promise<SlaveInfo[]> {
  return readJSON('slaves.json', [])
}

export async function saveSlaves(slaves: SlaveInfo[]): Promise<void> {
  await appendEvent('slaves.replaced', 'slave', { count: slaves.length })
  await writeJSON('slaves.json', slaves)
  emitProjectionUpdated('slaves')
}

export async function updateSlave(slaveId: string, updates: Partial<SlaveInfo>): Promise<void> {
  const slaves = await loadSlaves()
  const index = slaves.findIndex((s) => s.id === slaveId)
  if (index !== -1) {
    slaves[index] = { ...slaves[index], ...updates }
  } else {
    slaves.push({ id: slaveId, ...updates } as SlaveInfo)
  }
  await appendEvent('slave.upserted', 'slave', { updates }, slaveId)
  await writeJSON('slaves.json', slaves)
  emitProjectionUpdated('slaves', slaveId)
}

// Master state
export async function loadMasterState(): Promise<MasterState> {
  return readJSON('master.json', {
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
  })
}

export async function saveMasterState(state: MasterState): Promise<void> {
  await appendEvent('master.updated', 'master', { state }, 'master')
  await writeJSON('master.json', state)
  emitProjectionUpdated('master', 'master')
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
  const state = await loadMasterState()
  return state.pendingQuestions
}

export async function addQuestion(question: Question): Promise<void> {
  const state = await loadMasterState()
  state.pendingQuestions.push(question)
  await appendEvent('question.added', 'question', { question }, question.id)
  await saveMasterState(state)
}

export async function answerQuestion(questionId: string, answer: string): Promise<void> {
  const state = await loadMasterState()
  const q = state.pendingQuestions.find((q) => q.id === questionId)
  if (q) {
    q.answered = true
    q.answer = answer
    await appendEvent('question.answered', 'question', { answer }, questionId)
    await saveMasterState(state)
  }
}
