import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { runInspector, runWorker, runReviewer } from '../../src/slave/launcher';
import {
  addTask, loadTasks, updateTask, loadSlaves,
} from '../../src/utils/storage';
import {
  removeWorktree, deleteBranch, mergeBranch, getDiff,
} from '../../src/utils/git';
import { setupTestEnv, teardownTestEnv } from './setup';
import {
  createTestTask, createSimpleWorkTask, assertTaskResult, assertReviewResult,
  testMission, testRecentDecisions,
} from './helpers';

let testDir: string;

beforeAll(async () => {
  const env = await setupTestEnv();
  testDir = env.testDir;
});

afterAll(async () => {
  await teardownTestEnv();
});

async function cleanupWorktree(worktree: string, branch: string) {
  if (worktree && existsSync(worktree)) {
    await removeWorktree(worktree).catch(() => {});
  }
  if (branch) {
    await deleteBranch(branch).catch(() => {});
  }
}

const E2E_TIMEOUT = 180_000;
const TEST_BASE_BRANCH = 'main';

describe('完整集成流程', () => {
  test('手动创建任务 → Worker 执行 → Reviewer 通过 → 合并', async () => {
    const baseBranch = TEST_BASE_BRANCH;
    const task = createSimpleWorkTask(testDir);

    // 1. 添加任务到 storage
    await addTask(task);
    let tasks = await loadTasks();
    expect(tasks.find(t => t.id === task.id)).toBeDefined();

    // 2. Worker 执行
    await updateTask(task.id, { status: 'running' });
    const workerResult = await runWorker(
      task,
      testMission(),
      testRecentDecisions(),
      '',
      baseBranch,
    );

    expect(workerResult).not.toBeNull();
    assertTaskResult(workerResult);

    // 3. 更新任务状态为 reviewing
    await updateTask(task.id, {
      status: 'reviewing',
      worktree: workerResult!.worktree,
      branch: workerResult!.branch,
    });

    // 4. 获取 diff
    let diff = workerResult!.diff;
    if (!diff && workerResult!.worktree && workerResult!.branch) {
      diff = await getDiff(workerResult!.branch, baseBranch, workerResult!.worktree);
    }

    // 5. Reviewer 审查
    let reviewPassed = false;
    if (diff) {
      const reviewResult = await runReviewer(
        task,
        testMission(),
        testRecentDecisions(),
        diff,
      );

      expect(reviewResult).not.toBeNull();
      assertReviewResult(reviewResult);

      if (reviewResult!.verdict === 'approve') {
        reviewPassed = true;
        await updateTask(task.id, { status: 'approved' });
      } else {
        await updateTask(task.id, { status: 'pending' });
      }
    }

    // 6. 如果 review 通过，尝试合并
    if (reviewPassed && workerResult!.branch) {
      if (workerResult!.worktree) {
        await removeWorktree(workerResult!.worktree).catch(() => {});
      }
      const mergeResult = await mergeBranch(workerResult!.branch, baseBranch);
      if (mergeResult.success) {
        await updateTask(task.id, { status: 'completed' });
        await deleteBranch(workerResult!.branch).catch(() => {});
      }
    } else {
      await cleanupWorktree(workerResult!.worktree, workerResult!.branch);
    }

    // 7. 验证最终状态
    tasks = await loadTasks();
    const finalTask = tasks.find(t => t.id === task.id);
    expect(finalTask).toBeDefined();
    expect(['completed', 'approved', 'pending', 'reviewing']).toContain(finalTask!.status);
  }, E2E_TIMEOUT * 3); // Worker + Reviewer + merge 可能很慢

  test('Inspector 发现任务 → Worker 执行', async () => {
    // 1. Inspector 扫描
    const discoveredTasks = await runInspector(testMission(), testRecentDecisions());
    expect(Array.isArray(discoveredTasks)).toBe(true);

    // 2. 如果发现了任务，选一个执行
    if (discoveredTasks.length > 0) {
      const task = discoveredTasks[0];
      await addTask(task);

      const baseBranch = TEST_BASE_BRANCH;
      const result = await runWorker(
        task,
        testMission(),
        testRecentDecisions(),
        '',
        baseBranch,
      );

      expect(result).not.toBeNull();
      assertTaskResult(result);

      // 清理
      if (result!.worktree) {
        await cleanupWorktree(result!.worktree, result!.branch);
      }
    }
  }, E2E_TIMEOUT * 2);

  test('Worker + Review + 重试流程', async () => {
    const baseBranch = TEST_BASE_BRANCH;
    const task = createTestTask({
      description: 'Create a file called retry-test.txt with content "E2E test passed"',
      maxAttempts: 3,
    });

    // 1. 第一次 Worker 执行
    const firstResult = await runWorker(
      task,
      testMission(),
      testRecentDecisions(),
      '',
      baseBranch,
    );

    expect(firstResult).not.toBeNull();
    assertTaskResult(firstResult);

    // 2. 获取 diff 并 review
    let diff = firstResult!.diff;
    if (!diff && firstResult!.worktree && firstResult!.branch) {
      diff = await getDiff(firstResult!.branch, baseBranch, firstResult!.worktree);
    }

    if (diff) {
      const reviewResult = await runReviewer(
        task,
        testMission(),
        testRecentDecisions(),
        diff,
      );

      expect(reviewResult).not.toBeNull();
      assertReviewResult(reviewResult);

      // 记录 review
      await updateTask(task.id, {
        attemptCount: 1,
        reviewHistory: [{
          attempt: 1,
          slaveId: 'e2e-reviewer',
          review: reviewResult!,
          timestamp: new Date().toISOString(),
        }],
      });
    }

    // 清理
    if (firstResult!.worktree) {
      await cleanupWorktree(firstResult!.worktree, firstResult!.branch);
    }
  }, E2E_TIMEOUT * 2);
});
