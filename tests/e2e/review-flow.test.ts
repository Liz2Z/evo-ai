import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runReviewer } from '../../src/agents/launcher'
import {
  commitAllChanges,
  deleteBranch,
  ensureMissionWorkspace,
  getUncommittedDiff,
  removeWorktree,
} from '../../src/utils/git'
import { assertReviewResult, createTestTask, testMission, testRecentDecisions } from './helpers'
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

describe('Review 流程', () => {
  test(
    'Reviewer 使用 mission workspace 的未提交 diff 进行审查',
    async () => {
      if (!workspace) throw new Error('workspace missing')
      await writeFile(join(workspace.path, 'review-flow.txt'), 'review me\n')
      const diff = await getUncommittedDiff(workspace.path)
      const task = createTestTask({ description: 'Review mission diff' })

      const result = await runReviewer(
        task,
        testMission(),
        testRecentDecisions(),
        diff,
        workspace.path,
      )

      expect(result).not.toBeNull()
      assertReviewResult(result)
      expect(['approve', 'request_changes', 'reject']).toContain(result?.verdict)

      await commitAllChanges('task(test): cleanup review flow', workspace.path)
    },
    E2E_TIMEOUT,
  )
})
