import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AgentLauncher, runInspector, runReviewer, runWorker } from '../../src/agents/launcher'
import {
  deleteBranch,
  ensureMissionWorkspace,
  getUncommittedDiff,
  removeWorktree,
} from '../../src/utils/git'
import {
  assertReviewResult,
  assertTaskResult,
  createSimpleWorkTask,
  createTestTask,
  testMission,
  testRecentDecisions,
} from './helpers'
import { setupTestEnv, teardownTestEnv } from './setup'

let testDir: string
let workspace: { path: string; branch: string } | null = null

beforeAll(async () => {
  const env = await setupTestEnv()
  testDir = env.testDir
  process.chdir(testDir)
  workspace = await ensureMissionWorkspace(testMission(), 'main')
})

afterAll(async () => {
  if (workspace) {
    await removeWorktree(workspace.path).catch(() => {})
    await deleteBranch(workspace.branch).catch(() => {})
  }
  await teardownTestEnv()
})

const E2E_TIMEOUT = 180_000

describe('Slave 生命周期', () => {
  test(
    'Inspector 扫描代码库',
    async () => {
      const tasks = await runInspector(testMission(), testRecentDecisions())
      expect(Array.isArray(tasks)).toBe(true)
      for (const task of tasks) {
        expect(task.id).toBeDefined()
        expect(task.status).toBe('pending')
      }
    },
    E2E_TIMEOUT,
  )

  test(
    'Worker 在 mission workspace 中执行任务',
    async () => {
      if (!workspace) throw new Error('workspace missing')
      const task = createSimpleWorkTask(testDir)
      const result = await runWorker(task, testMission(), testRecentDecisions(), '', workspace.path)
      expect(result).not.toBeNull()
      assertTaskResult(result)
      expect(result?.taskId).toBe(task.id)
    },
    E2E_TIMEOUT,
  )

  test(
    'Reviewer 审查 mission workspace 中的代码变更',
    async () => {
      if (!workspace) throw new Error('workspace missing')
      const task = createTestTask()
      const sampleDiff = await getUncommittedDiff(workspace.path)
      const result = await runReviewer(
        task,
        testMission(),
        testRecentDecisions(),
        sampleDiff || 'diff --git a/a b/a',
        workspace.path,
      )
      expect(result).not.toBeNull()
      assertReviewResult(result)
    },
    E2E_TIMEOUT,
  )

  test('AgentLauncher start/cancel 可正常执行', async () => {
    if (!workspace) throw new Error('workspace missing')
    const task = createTestTask({ description: 'Storage registration test' })
    const launcher = new AgentLauncher({
      type: 'worker',
      task,
      mission: testMission(),
      recentDecisions: testRecentDecisions(),
      worktreePath: workspace.path,
    })

    const { agentId } = await launcher.start()
    expect(agentId.startsWith('worker-')).toBe(true)
    await launcher.cancel()
  })

  test('Slave cancel 后可以重复调用且不抛错', async () => {
    const task = createTestTask({ description: 'Cancel test' })
    const launcher = new AgentLauncher({
      type: 'worker',
      task,
      mission: testMission(),
      recentDecisions: testRecentDecisions(),
    })

    await launcher.start()
    await launcher.cancel()
    await launcher.cancel()
    expect(true).toBe(true)
  })
})
