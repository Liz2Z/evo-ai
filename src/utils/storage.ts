import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import type { Task, SlaveInfo, MasterState, HistoryEntry, Config, Question } from '../types';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');

async function ensureDir(path: string) {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true });
  }
}

export async function readJSON<T>(filename: string, defaultValue: T): Promise<T> {
  const filepath = join(DATA_DIR, filename);
  try {
    const content = await Bun.file(filepath).text();
    return JSON.parse(content);
  } catch {
    return defaultValue;
  }
}

export async function writeJSON<T>(filename: string, data: T): Promise<void> {
  await ensureDir(DATA_DIR);
  const filepath = join(DATA_DIR, filename);
  await Bun.write(filepath, JSON.stringify(data, null, 2));
}

// Tasks storage
export async function loadTasks(): Promise<Task[]> {
  return readJSON('tasks.json', []);
}

export async function saveTasks(tasks: Task[]): Promise<void> {
  return writeJSON('tasks.json', tasks);
}

export async function addTask(task: Task): Promise<void> {
  const tasks = await loadTasks();
  tasks.push(task);
  await saveTasks(tasks);
}

export async function updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
  const tasks = await loadTasks();
  const index = tasks.findIndex(t => t.id === taskId);
  if (index === -1) return null;
  tasks[index] = { ...tasks[index], ...updates, updatedAt: new Date().toISOString() };
  await saveTasks(tasks);
  return tasks[index];
}

export async function getTask(taskId: string): Promise<Task | null> {
  const tasks = await loadTasks();
  return tasks.find(t => t.id === taskId) || null;
}

// Slave storage
export async function loadSlaves(): Promise<SlaveInfo[]> {
  return readJSON('slaves.json', []);
}

export async function saveSlaves(slaves: SlaveInfo[]): Promise<void> {
  return writeJSON('slaves.json', slaves);
}

export async function updateSlave(slaveId: string, updates: Partial<SlaveInfo>): Promise<void> {
  const slaves = await loadSlaves();
  const index = slaves.findIndex(s => s.id === slaveId);
  if (index !== -1) {
    slaves[index] = { ...slaves[index], ...updates };
  } else {
    slaves.push({ id: slaveId, ...updates } as SlaveInfo);
  }
  await saveSlaves(slaves);
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
  });
}

export async function saveMasterState(state: MasterState): Promise<void> {
  return writeJSON('master.json', state);
}

// History
export async function loadHistory(date?: string): Promise<HistoryEntry[]> {
  const filename = date 
    ? `history/${date}.json`
    : `history/${new Date().toISOString().split('T')[0]}.json`;
  return readJSON(filename, []);
}

export async function addHistoryEntry(entry: HistoryEntry): Promise<void> {
  const date = new Date().toISOString().split('T')[0];
  const history = await loadHistory(date);
  history.push(entry);
  await ensureDir(join(DATA_DIR, 'history'));
  await writeJSON(`history/${date}.json`, history);
}

// Config
export async function loadConfig(): Promise<Config> {
  return readJSON('../config.json', {
    mission: 'Improve code quality',
    heartbeatInterval: 30000,
    maxConcurrency: 3,
    maxRetryAttempts: 3,
    worktreesDir: '.worktrees',
    developBranch: 'develop',
    slaveCommand: 'pi',
  });
}

export async function saveConfig(config: Config): Promise<void> {
  return writeJSON('../config.json', config);
}

// Failed tasks
export async function loadFailedTasks(): Promise<Task[]> {
  return readJSON('failed_tasks.json', []);
}

export async function addFailedTask(task: Task): Promise<void> {
  const failed = await loadFailedTasks();
  failed.push(task);
  await writeJSON('failed_tasks.json', failed);
}

// Questions
export async function loadQuestions(): Promise<Question[]> {
  const state = await loadMasterState();
  return state.pendingQuestions;
}

export async function addQuestion(question: Question): Promise<void> {
  const state = await loadMasterState();
  state.pendingQuestions.push(question);
  await saveMasterState(state);
}

export async function answerQuestion(questionId: string, answer: string): Promise<void> {
  const state = await loadMasterState();
  const q = state.pendingQuestions.find(q => q.id === questionId);
  if (q) {
    q.answered = true;
    q.answer = answer;
    await saveMasterState(state);
  }
}
