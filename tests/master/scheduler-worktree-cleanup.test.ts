// Auto-generated
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWorktree, deleteBranch, removeWorktree } from '../../src/utils/git';
import type { Config, ReviewResult, Task } from '../../src/types';
import { createTestTask } from '../e2e/helpers';

const originalCwd = process.cwd();
let dataDir: string;
let repoDir: string;
let MasterClass: typeof import('../../src/master/scheduler').Master;
let addTaskFn: typeof import('../../src/utils/storage').addTask;
let loadTasksFn: typeof import('../../src/utils/storage').loadTasks;
let updateSlaveFn: typeof import('../../src/utils/storage').updateSlave;
let loadSlavesFn: typeof import('../../src/utils/storage').loadSlaves;

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
};

beforeAll(async () => {
  repoDir = join(tmpdir(), `evo-ai-master-repo-${Date.now()}`);
  dataDir = join(repoDir, 'data');
  await mkdir(repoDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(repoDir, '.worktrees'), { recursive: true });
  await writeFile(join(repoDir, 'README.md'), '# scheduler test repo\n');

  runCmd('git', ['init'], repoDir);
  runCmd('git', ['checkout', '-b', 'main'], repoDir);
  runCmd('git', ['config', 'user.email', 'test@evo-ai.dev'], repoDir);
  runCmd('git', ['config', 'user.name', 'Evo AI Test'], repoDir);
  runCmd('git', ['add', '-A'], repoDir);
  runCmd('git', ['commit', '-m', 'Initial commit'], repoDir);

  process.chdir(repoDir);

  ({ Master: MasterClass } = await import('../../src/master/scheduler'));
  ({
    addTask: addTaskFn,
    loadTasks: loadTasksFn,
    updateSlave: updateSlaveFn,
    loadSlaves: loadSlavesFn,
  } = await import('../../src/utils/storage'));
});

afterAll(async () => {
  process.chdir(originalCwd);

  await rm(repoDir, { recursive: true, force: true });
});

async function createReviewingTask(): Promise<Task> {
  const baseBranch = baseConfig.developBranch;
  const task = createTestTask({ status: 'reviewing' });
  const worktree = await createWorktree(task, baseBranch);
  if (!worktree) {
    throw new Error('failed to create worktree for test');
  }

  const storedTask: Task = {
    ...task,
    worktree: worktree.path,
    branch: worktree.branch,
  };

  await addTaskFn(storedTask);
  return storedTask;
}

async function cleanupBranch(task: Task): Promise<void> {
  if (task.branch) {
    await deleteBranch(task.branch).catch(() => {});
  }
}

function runCmd(cmd: string, args: string[], cwd: string): void {
  const proc = Bun.spawnSync([cmd, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${proc.stderr.toString()}`);
  }
}

describe('Master worktree cleanup', () => {
  test('review approve 后自动清理 worktree', async () => {
    const task = await createReviewingTask();
    const master = new MasterClass(baseConfig, 'test mission') as any;
    const review: ReviewResult = {
      taskId: task.id,
      verdict: 'approve',
      confidence: 0.9,
      summary: 'looks good',
      issues: [],
      suggestions: [],
    };

    try {
      expect(existsSync(task.worktree!)).toBe(true);

      await master.handleReviewResult(task, review);

      expect(existsSync(task.worktree!)).toBe(false);

      const tasks = await loadTasksFn();
      const updated = tasks.find(t => t.id === task.id);
      expect(updated?.status).toBe('approved');
      expect(updated?.worktree).toBeUndefined();
      expect(updated?.branch).toBeDefined();
      expect(updated?.branch).toBe(task.branch!);
    } finally {
      await cleanupBranch(task);
    }
  });

  test('无 diff 自动 approve 时也清理 worktree', async () => {
    const task = await createReviewingTask();
    const master = new MasterClass(baseConfig, 'test mission') as any;

    try {
      expect(existsSync(task.worktree!)).toBe(true);

      await master.assignReviewer(task);

      expect(existsSync(task.worktree!)).toBe(false);

      const tasks = await loadTasksFn();
      const updated = tasks.find(t => t.id === task.id);
      expect(updated?.status).toBe('approved');
      expect(updated?.worktree).toBeUndefined();
      expect(updated?.branch).toBeDefined();
      expect(updated?.branch).toBe(task.branch!);
    } finally {
      await cleanupBranch(task);
    }
  });

  test('启动恢复后保留 running 任务的 worktree，并转为 pending 继续执行', async () => {
    const baseBranch = baseConfig.developBranch;
    const task = createTestTask({ status: 'running' });
    const worktree = await createWorktree(task, baseBranch);
    if (!worktree) {
      throw new Error('failed to create worktree for recovery test');
    }

    const storedTask: Task = {
      ...task,
      worktree: worktree.path,
      branch: worktree.branch,
    };

    await addTaskFn(storedTask);
    await updateSlaveFn('worker-recovery-test', {
      id: 'worker-recovery-test',
      type: 'worker',
      status: 'busy',
      currentTask: task.id,
      startedAt: new Date().toISOString(),
    });

    const master = new MasterClass(baseConfig, 'test mission') as any;

    try {
      expect(existsSync(worktree.path)).toBe(true);

      await master.recoverStaleRuntimeState();
      await master.cleanupStaleWorktrees();

      expect(existsSync(worktree.path)).toBe(true);

      const tasks = await loadTasksFn();
      const updatedTask = tasks.find(t => t.id === task.id);
      expect(updatedTask?.status).toBe('pending');
      expect(updatedTask?.worktree).toBe(worktree.path);
      expect(updatedTask?.branch).toBe(worktree.branch);

      const slaves = await loadSlavesFn();
      const updatedSlave = slaves.find(s => s.id === 'worker-recovery-test');
      expect(updatedSlave?.status).toBe('idle');
      expect(updatedSlave?.currentTask).toBeUndefined();
    } finally {
      if (existsSync(worktree.path)) {
        await removeWorktree(worktree.path).catch(() => {});
      }
      await cleanupBranch(storedTask);
    }
  });
});
