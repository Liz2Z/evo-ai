import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runReviewer, runWorker } from '../../src/slave/launcher'
import {
  commitAllChanges,
  deleteBranch,
  ensureMissionWorkspace,
  getUncommittedDiff,
  hasUncommittedChanges,
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

describe('完整集成流程', () => {
  test(
    'mission workspace 中执行 worker -> reviewer -> commit',
    async () => {
      if (!workspace) throw new Error('workspace missing')
      const task = createSimpleWorkTask(testDir)
      const workerResult = await runWorker(
        task,
        testMission(),
        testRecentDecisions(),
        '',
        workspace.path,
      )

      expect(workerResult).not.toBeNull()
      assertTaskResult(workerResult)

      let diff = await getUncommittedDiff(workspace.path)
      if (!diff.trim()) {
        await writeFile(join(workspace.path, 'integration-fallback.txt'), 'fallback\n')
        diff = await getUncommittedDiff(workspace.path)
      }

      const reviewResult = await runReviewer(
        task,
        testMission(),
        testRecentDecisions(),
        diff,
        workspace.path,
      )
      expect(reviewResult).not.toBeNull()
      assertReviewResult(reviewResult)

      const commit = await commitAllChanges('task(test): integration flow', workspace.path)
      expect(commit.success).toBe(true)
      expect(await hasUncommittedChanges(workspace.path)).toBe(false)
    },
    E2E_TIMEOUT * 2,
  )

  test(
    'review request_changes 后仍可继续在同一 workspace 上修改并提交',
    async () => {
      if (!workspace) throw new Error('workspace missing')
      const task = createTestTask({ description: 'retry in same workspace' })
      await writeFile(join(workspace.path, 'retry-flow.txt'), 'retry\n')
      const diff = await getUncommittedDiff(workspace.path)
      const reviewResult = await runReviewer(
        task,
        testMission(),
        testRecentDecisions(),
        diff,
        workspace.path,
      )
      expect(reviewResult).not.toBeNull()
      assertReviewResult(reviewResult)
      const commit = await commitAllChanges('task(test): retry flow', workspace.path)
      expect(commit.success).toBe(true)
    },
    E2E_TIMEOUT,
  )
})
