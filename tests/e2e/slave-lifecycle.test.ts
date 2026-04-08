// Auto-generated
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { SlaveLauncher, runInspector, runWorker, runReviewer } from '../../src/slave/launcher';
import { loadSlaves, loadTasks } from '../../src/utils/storage';
import { removeWorktree, deleteBranch } from '../../src/utils/git';
import { setupTestEnv, teardownTestEnv } from './setup';
import {
  createTestTask,
  createSimpleWorkTask,
  assertTaskResult,
  assertReviewResult,
  testMission,
  testRecentDecisions,
} from './helpers';

let testDir: string;

beforeAll(async () => {
  const env = await setupTestEnv();
  testDir = env.testDir;
});

afterAll(async () => {
  await teardownTestEnv();
});

// E2E 测试需要较长的超时（Claude API 调用）
const E2E_TIMEOUT = 180_000;
const TEST_BASE_BRANCH = 'main';

describe('Slave 生命周期', () => {
  test('Inspector 扫描代码库', async () => {
    const tasks = await runInspector(testMission(), testRecentDecisions());

    // Inspector 应该返回一个数组
    expect(Array.isArray(tasks)).toBe(true);

    // 如果有任务，验证结构
    for (const task of tasks) {
      expect(task.id).toBeDefined();
      expect(task.type).toBeDefined();
      expect(task.description).toBeDefined();
      expect(task.status).toBe('pending');
    }
  }, E2E_TIMEOUT);

  test('Worker 执行简单任务并创建 worktree', async () => {
    const task = createSimpleWorkTask(testDir);
    const baseBranch = TEST_BASE_BRANCH;

    const result = await runWorker(
      task,
      testMission(),
      testRecentDecisions(),
      '',
      baseBranch,
    );

    // 验证结果
    expect(result).not.toBeNull();
    assertTaskResult(result);
    expect(result!.taskId).toBe(task.id);

    // Worker 应该创建了 worktree
    if (result!.worktree && existsSync(result!.worktree)) {
      expect(result!.branch).toBeTruthy();

      // 清理 worktree 和分支
      await removeWorktree(result!.worktree).catch(() => {});
      if (result!.branch) {
        await deleteBranch(result!.branch).catch(() => {});
      }
    }
  }, E2E_TIMEOUT);

  test('Reviewer 审查代码变更', async () => {
    const task = createTestTask();
    const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
index 1234567..abcdefg 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,1 +1,2 @@
 // initial
+// added by worker
`;

    const result = await runReviewer(
      task,
      testMission(),
      testRecentDecisions(),
      sampleDiff,
    );

    // 验证结果
    expect(result).not.toBeNull();
    assertReviewResult(result);
    expect(result!.taskId).toBe(task.id);
    expect(['approve', 'request_changes', 'reject']).toContain(result!.verdict);
    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  }, E2E_TIMEOUT);

  test('Slave 注册到 storage', async () => {
    const task = createTestTask({ description: 'Storage registration test' });

    const launcher = new SlaveLauncher({
      type: 'worker',
      task,
      mission: testMission(),
      recentDecisions: testRecentDecisions(),
      baseBranch: TEST_BASE_BRANCH,
    });

    const { slaveId } = await launcher.start();

    // 验证 slave 注册
    const slaves = await loadSlaves();
    const found = slaves.find(s => s.id === slaveId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('busy');
    expect(found!.currentTask).toBe(task.id);

    // 清理（不执行，直接取消）
    await launcher.cancel();
  });

  test('Slave cancel 后状态更新', async () => {
    const task = createTestTask({ description: 'Cancel test' });

    const launcher = new SlaveLauncher({
      type: 'worker',
      task,
      mission: testMission(),
      recentDecisions: testRecentDecisions(),
    });

    const { slaveId } = await launcher.start();
    await launcher.cancel();

    // 验证 slave 状态变为 idle
    const slaves = await loadSlaves();
    const found = slaves.find(s => s.id === slaveId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('idle');
    expect(found!.currentTask).toBeUndefined();
  });

  test('SlaveLauncher execute 后 cleanup', async () => {
    const task = createSimpleWorkTask(testDir);

    const launcher = new SlaveLauncher({
      type: 'worker',
      task,
      mission: testMission(),
      recentDecisions: testRecentDecisions(),
      baseBranch: TEST_BASE_BRANCH,
    });

    const { slaveId } = await launcher.start();
    const result = await launcher.execute();

    // 验证 slave 状态变为 idle（cleanup 在 finally 中执行）
    const slaves = await loadSlaves();
    const found = slaves.find(s => s.id === slaveId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('idle');

    // 清理可能留下的 worktree
    if (result && 'worktree' in result && result.worktree) {
      await removeWorktree(result.worktree).catch(() => {});
      if (result.branch) {
        await deleteBranch(result.branch).catch(() => {});
      }
    }
  }, E2E_TIMEOUT);
});
