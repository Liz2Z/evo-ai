import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config, Task } from '../../src/types'
import { ensureMissionWorkspace, removeWorktree } from '../../src/utils/git'
import { addTask, loadMasterState, loadTasks, updateSlave } from '../../src/utils/storage'

const originalCwd = process.cwd()
let repoDir: string
let MasterClass: typeof import('../../src/master/scheduler').Master

const baseConfig: Config = {
  heartbeatInterval: 30_000,
  maxConcurrency: 1,
  maxRetryAttempts: 3,
  worktreesDir: '.worktrees',
  developBranch: 'main',
  models: {
    lite: 'haiku',
    pro: 'sonnet',
    max: 'opus',
  },
  provider: {},
  master: {
    runtimeMode: 'hybrid',
  },
}

beforeAll(async () => {
  repoDir = join(tmpdir(), `evo-ai-master-repo-${Date.now()}`)
  await mkdir(repoDir, { recursive: true })
  await mkdir(join(repoDir, '.evo-ai', '.data'), { recursive: true })
  await mkdir(join(repoDir, '.worktrees'), { recursive: true })
  await writeFile(join(repoDir, 'README.md'), '# scheduler test repo\n')

  runCmd('git', ['init'], repoDir)
  runCmd('git', ['checkout', '-b', 'main'], repoDir)
  runCmd('git', ['config', 'user.email', 'test@evo-ai.dev'], repoDir)
  runCmd('git', ['config', 'user.name', 'Evo AI Test'], repoDir)
  runCmd('git', ['add', '-A'], repoDir)
  runCmd('git', ['commit', '-m', 'Initial commit'], repoDir)

  process.chdir(repoDir)
  ;({ Master: MasterClass } = await import('../../src/master/scheduler'))
})

afterAll(async () => {
  process.chdir(originalCwd)
  await rm(repoDir, { recursive: true, force: true })
})

function runCmd(cmd: string, args: string[], cwd: string): void {
  const proc = Bun.spawnSync([cmd, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${proc.stderr.toString()}`)
  }
}

function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString()
  return {
    id: `task-${Date.now()}`,
    type: 'other',
    status: 'pending',
    priority: 3,
    description: 'scheduler mission workspace test',
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    maxAttempts: 3,
    reviewHistory: [],
    ...overrides,
  }
}

describe('Master mission workspace recovery', () => {
  const mission = 'scheduler workspace mission'

  test('启动后会创建并记录 mission worktree', async () => {
    const master = new MasterClass(baseConfig, mission)
    await master.start()
    try {
      const state = await loadMasterState()
      expect(state.missionWorktree).toBeDefined()
      expect(state.missionBranch).toBeDefined()
      expect(existsSync(state.missionWorktree!)).toBe(true)
    } finally {
      await master.stop()
    }
  })

  test('恢复时保留 mission worktree，并把 busy slave 置为 idle', async () => {
    const workspace = await ensureMissionWorkspace(mission, 'main')
    if (!workspace) throw new Error('workspace missing')

    const task = createTask({ status: 'running' })
    await addTask(task)
    await updateSlave('worker-recovery-test', {
      id: 'worker-recovery-test',
      type: 'worker',
      status: 'busy',
      currentTask: task.id,
      startedAt: new Date().toISOString(),
    })

    const master = new MasterClass(baseConfig, mission) as any
    master.state.missionWorktree = workspace.path
    master.state.missionBranch = workspace.branch
    master.state.currentTaskId = task.id
    master.state.currentStage = 'working'

    await master.start()
    try {
      const state = await loadMasterState()
      const tasks = await loadTasks()
      expect(state.missionWorktree).toBe(workspace.path)
      expect(existsSync(workspace.path)).toBe(true)
      expect(tasks.find((t) => t.id === task.id)?.status).toBe('pending')
    } finally {
      await master.stop()
      await removeWorktree(workspace.path).catch(() => {})
    }
  })

  test('恢复孤儿任务时会清理 currentTaskId 并回到 idle', async () => {
    const workspace = await ensureMissionWorkspace(mission, 'main')
    if (!workspace) throw new Error('workspace missing')

    const task = createTask({ status: 'running' })
    await addTask(task)
    await updateSlave('worker-orphan-test', {
      id: 'worker-orphan-test',
      type: 'worker',
      status: 'busy',
      currentTask: task.id,
      startedAt: new Date().toISOString(),
      pid: 999999,
    })

    const master = new MasterClass(baseConfig, mission) as any
    master.state.missionWorktree = workspace.path
    master.state.missionBranch = workspace.branch
    master.state.currentTaskId = task.id
    master.state.currentStage = 'working'

    await master.start()
    try {
      const state = await loadMasterState()
      const tasks = await loadTasks()
      expect(state.currentTaskId).toBeUndefined()
      expect(state.currentStage).toBe('idle')
      expect(tasks.find((item) => item.id === task.id)?.status).toBe('pending')
    } finally {
      await master.stop()
      await removeWorktree(workspace.path).catch(() => {})
    }
  })
})
