import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Master } from '../../src/master/scheduler'
import type { Config, ReviewResult, Task } from '../../src/types'
import {
  commitAllChanges,
  ensureMissionWorkspace,
  removeWorktree,
  runGit,
} from '../../src/utils/git'
import {
  addMissionHistoryEntry,
  addTask,
  getTask,
  loadMasterState,
  loadMissionHistory,
  saveTasks,
} from '../../src/utils/storage'

const originalCwd = process.cwd()
let repoDir: string

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
  repoDir = join(tmpdir(), `evo-ai-master-commit-guards-${Date.now()}`)
  await mkdir(repoDir, { recursive: true })
  await mkdir(join(repoDir, '.evo-ai', '.data'), { recursive: true })
  await mkdir(join(repoDir, '.worktrees'), { recursive: true })
  await writeFile(join(repoDir, 'README.md'), '# commit guard test repo\n')

  runCmd('git', ['init'], repoDir)
  runCmd('git', ['checkout', '-b', 'main'], repoDir)
  runCmd('git', ['config', 'user.email', 'test@evo-ai.dev'], repoDir)
  runCmd('git', ['config', 'user.name', 'Evo AI Test'], repoDir)
  runCmd('git', ['add', '-A'], repoDir)
  runCmd('git', ['commit', '-m', 'Initial commit'], repoDir)

  process.chdir(repoDir)
})

afterAll(async () => {
  process.chdir(originalCwd)
  await rm(repoDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await saveTasks([])
})

function runCmd(cmd: string, args: string[], cwd: string): void {
  const proc = Bun.spawnSync([cmd, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${proc.stderr.toString()}`)
  }
}

function createApprovedReview(taskId: string): ReviewResult {
  return {
    taskId,
    verdict: 'approve',
    confidence: 0.98,
    summary: 'ready to commit',
    issues: [],
    suggestions: [],
  }
}

function createTask(taskId: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString()
  return {
    id: taskId,
    type: 'refactor',
    status: 'reviewing',
    priority: 5,
    description: `commit guard task ${taskId}`,
    createdAt: now,
    updatedAt: now,
    attemptCount: 1,
    maxAttempts: 3,
    reviewHistory: [
      {
        attempt: 1,
        slaveId: 'reviewer',
        review: createApprovedReview(taskId),
        timestamp: now,
      },
    ],
    ...overrides,
  }
}

describe('Master commit_current_task guards', () => {
  test('错误分支上的 mission worktree 禁止提交', async () => {
    const mission = `branch-guard-${Date.now()}`
    const workspace = await ensureMissionWorkspace(mission, 'main')
    if (!workspace) throw new Error('workspace missing')

    const taskId = `task-branch-${Date.now()}`
    const task = createTask(taskId)
    await addTask(task)
    await writeFile(join(workspace.path, 'branch-guard.txt'), 'branch mismatch\n')
    runCmd('git', ['checkout', '-b', `rogue/${Date.now()}`], workspace.path)

    const master = new Master(baseConfig, mission) as any
    master.state.missionWorktree = workspace.path
    master.state.missionBranch = workspace.branch
    master.state.currentTaskId = taskId
    master.state.currentStage = 'committing'

    try {
      const result = await master.commitCurrentTask()
      expect(result.status).toBe('failed')
      expect(result.message).toContain('Mission worktree branch mismatch')

      const status = await runGit(['status', '--porcelain'], workspace.path)
      expect(status.stdout).toContain('branch-guard.txt')
    } finally {
      await removeWorktree(workspace.path).catch(() => {})
    }
  })

  test('未经过 approve review 的任务禁止提交', async () => {
    const mission = `review-guard-${Date.now()}`
    const workspace = await ensureMissionWorkspace(mission, 'main')
    if (!workspace) throw new Error('workspace missing')

    const taskId = `task-review-${Date.now()}`
    const task = createTask(taskId, { reviewHistory: [] })
    await addTask(task)
    await writeFile(join(workspace.path, 'review-guard.txt'), 'review required\n')

    const master = new Master(baseConfig, mission) as any
    master.state.missionWorktree = workspace.path
    master.state.missionBranch = workspace.branch
    master.state.currentTaskId = taskId
    master.state.currentStage = 'committing'

    try {
      const result = await master.commitCurrentTask()
      expect(result.status).toBe('failed')
      expect(result.message).toContain('has not been approved by review')

      const persistedTask = await getTask(taskId)
      expect(persistedTask?.status).toBe('reviewing')
    } finally {
      await removeWorktree(workspace.path).catch(() => {})
    }
  })

  test('review approve 且分支正确时允许在 mission branch 提交', async () => {
    const mission = `success-guard-${Date.now()}`
    const workspace = await ensureMissionWorkspace(mission, 'main')
    if (!workspace) throw new Error('workspace missing')

    const taskId = `task-success-${Date.now()}`
    const task = createTask(taskId)
    await addTask(task)
    await writeFile(join(workspace.path, 'success-guard.txt'), 'ready to commit\n')

    const master = new Master(baseConfig, mission) as any
    master.state.missionWorktree = workspace.path
    master.state.missionBranch = workspace.branch
    master.state.currentTaskId = taskId
    master.state.currentStage = 'committing'

    try {
      const result = await master.commitCurrentTask()
      expect(result.status).toBe('committed')

      const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.path)
      expect(branch.stdout).toBe(workspace.branch)

      const persistedTask = await getTask(taskId)
      expect(persistedTask?.status).toBe('completed')
    } finally {
      await removeWorktree(workspace.path).catch(() => {})
    }
  })

  test('没有 pending 任务时会直接合并 mission 分支，即使存在 failed 任务', async () => {
    const mission = `complete-mission-${Date.now()}`
    const workspace = await ensureMissionWorkspace(mission, 'main')
    if (!workspace) throw new Error('workspace missing')

    await addMissionHistoryEntry({
      mission,
      startedAt: new Date().toISOString(),
      worktreeBranch: workspace.branch,
      worktreePath: workspace.path,
      taskCount: 2,
    })

    const completedTask = createTask(`task-complete-${Date.now()}`, { status: 'completed' })
    const failedTask = createTask(`task-failed-${Date.now()}`, {
      status: 'failed',
      reviewHistory: [],
      attemptCount: 2,
    })
    await addTask(completedTask)
    await addTask(failedTask)
    await writeFile(join(workspace.path, 'mission-complete.txt'), 'merge target\n')
    const commit = await commitAllChanges('task(test): mission completion', workspace.path)
    expect(commit.success).toBe(true)

    const master = new Master(baseConfig, mission) as any
    master.state.missionWorktree = workspace.path
    master.state.missionBranch = workspace.branch
    master.state.currentStage = 'idle'

    const result = await master.completeMission()
    expect(result.status).toBe('merged')
    expect(existsSync(workspace.path)).toBe(false)

    const mainLog = await runGit(['log', '--oneline', '-1'], repoDir)
    expect(mainLog.stdout).toContain('Merge')
    expect(existsSync(join(repoDir, 'mission-complete.txt'))).toBe(true)

    const branch = await runGit(['rev-parse', '--verify', workspace.branch], repoDir)
    expect(branch.exitCode).not.toBe(0)

    const state = await loadMasterState()
    expect(state.missionWorktree).toBeUndefined()
    expect(state.missionBranch).toBeUndefined()

    const missionHistory = await loadMissionHistory()
    const historyEntry = missionHistory.find((entry) => entry.mission === mission && entry.endedAt)
    expect(historyEntry?.endedAt).toBeDefined()
  })
})
