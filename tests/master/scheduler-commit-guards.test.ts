import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Master } from '../../src/master/scheduler'
import type { Config, ReviewResult, Task } from '../../src/types'
import { ensureMissionWorkspace, removeWorktree, runGit } from '../../src/utils/git'
import { addTask, getTask } from '../../src/utils/storage'

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
})
