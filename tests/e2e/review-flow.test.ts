// Auto-generated
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { runReviewer, runWorker, SlaveLauncher } from '../../src/slave/launcher'
import { deleteBranch, getDiff, removeWorktree } from '../../src/utils/git'
import { addTask, loadTasks, updateTask } from '../../src/utils/storage'
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

beforeAll(async () => {
  const env = await setupTestEnv()
  testDir = env.testDir
})

afterAll(async () => {
  await teardownTestEnv()
})

const E2E_TIMEOUT = 180_000
const TEST_BASE_BRANCH = 'main'

describe('Review 流程', () => {
  test(
    'Worker 执行 + Reviewer 审查完整流程',
    async () => {
      const baseBranch = TEST_BASE_BRANCH

      // 1. Worker 执行任务
      const task = createSimpleWorkTask(testDir)
      const workerResult = await runWorker(
        task,
        testMission(),
        testRecentDecisions(),
        '',
        baseBranch,
      )

      expect(workerResult).not.toBeNull()
      assertTaskResult(workerResult)
      expect(workerResult!.worktree).toBeTruthy()
      expect(workerResult!.branch).toBeTruthy()

      // 2. 获取 diff
      let diff = workerResult!.diff
      if (!diff && workerResult!.worktree && workerResult!.branch) {
        diff = await getDiff(workerResult!.branch, baseBranch, workerResult!.worktree)
      }

      // 3. Reviewer 审查
      if (diff) {
        const reviewResult = await runReviewer(task, testMission(), testRecentDecisions(), diff)

        expect(reviewResult).not.toBeNull()
        assertReviewResult(reviewResult)
        expect(['approve', 'request_changes', 'reject']).toContain(reviewResult!.verdict)
      }

      // 4. 清理
      if (workerResult!.worktree) {
        await removeWorktree(workerResult!.worktree).catch(() => {})
      }
      if (workerResult!.branch) {
        await deleteBranch(workerResult!.branch).catch(() => {})
      }
    },
    E2E_TIMEOUT * 2,
  ) // Worker + Reviewer 需要更长时间

  test(
    'Reviewer 对高质量变更应该给出正面评价',
    async () => {
      const task = createTestTask()

      const goodDiff = `diff --git a/src/utils.ts b/src/utils.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,15 @@
+/**
+ * Format a date string to a human-readable format.
+ * @param dateStr - ISO date string
+ * @returns Formatted date string
+ */
+export function formatDate(dateStr: string): string {
+  const date = new Date(dateStr);
+  if (isNaN(date.getTime())) {
+    throw new Error('Invalid date string');
+  }
+  return date.toLocaleDateString('en-US', {
+    year: 'numeric',
+    month: 'long',
+    day: 'numeric',
+  });
+}
`

      const result = await runReviewer(task, testMission(), testRecentDecisions(), goodDiff)

      expect(result).not.toBeNull()
      assertReviewResult(result)
      expect(result!.confidence).toBeGreaterThan(0)
    },
    E2E_TIMEOUT,
  )

  test(
    'Reviewer 对低质量变更应该提出问题',
    async () => {
      const task = createTestTask()

      const badDiff = `diff --git a/src/index.ts b/src/index.ts
index 1234567..abcdefg 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
 import { something } from './utils';

-console.log("hello");
+console.log("debugging...");
+console.log("more debugging...");
+var x = eval("1+1");
+// TODO fix later
`

      const result = await runReviewer(task, testMission(), testRecentDecisions(), badDiff)

      expect(result).not.toBeNull()
      assertReviewResult(result)
      expect(result!.summary).toBeDefined()
    },
    E2E_TIMEOUT,
  )

  test(
    '多次 review 后达到最大尝试次数',
    async () => {
      const task = createTestTask({
        maxAttempts: 2,
        attemptCount: 1,
      })

      const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,1 +1,1 @@
-old
+new
`

      const result = await runReviewer(task, testMission(), testRecentDecisions(), sampleDiff)

      expect(result).not.toBeNull()
      assertReviewResult(result)
    },
    E2E_TIMEOUT,
  )
})
