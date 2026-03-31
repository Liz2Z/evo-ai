import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  createWorktree,
  removeWorktree,
  getDiff,
  getChangedFiles,
  commitChanges,
  mergeBranch,
  deleteBranch,
  hasUncommittedChanges,
  isGitRepo,
} from '../../src/utils/git';
import { createTestTask } from './helpers';

// 使用真实项目 repo（createWorktree 使用 process.cwd()）
const projectDir = process.cwd();
const worktreeCleanup: { path: string; branch: string }[] = [];

afterAll(async () => {
  // 清理所有测试创建的 worktree 和分支
  for (const { path, branch } of worktreeCleanup) {
    if (existsSync(path)) {
      await removeWorktree(path).catch(() => {});
    }
    await deleteBranch(branch).catch(() => {});
  }
});

async function getMainBranch(): Promise<string> {
  const result = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: projectDir,
    stdout: 'pipe',
  });
  return result.stdout.toString().trim() || 'main';
}

function trackCleanup(path: string, branch: string) {
  worktreeCleanup.push({ path, branch });
}

describe('Worktree 管理', () => {
  test('是 git repo', async () => {
    expect(await isGitRepo()).toBe(true);
  });

  test('创建 worktree', async () => {
    const task = createTestTask();
    const mainBranch = await getMainBranch();

    const result = await createWorktree(task, mainBranch);
    expect(result).not.toBeNull();
    expect(result!.path).toContain('.worktrees');
    expect(result!.branch).toBe(`task/${task.id}`);
    expect(existsSync(result!.path)).toBe(true);

    trackCleanup(result!.path, result!.branch);

    // 验证分支存在
    const branchCheck = Bun.spawnSync(
      ['git', 'rev-parse', '--verify', result!.branch],
      { cwd: projectDir, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(branchCheck.exitCode).toBe(0);
  });

  test('创建已存在的 worktree 返回相同路径（幂等）', async () => {
    const task = createTestTask();
    const mainBranch = await getMainBranch();

    const first = await createWorktree(task, mainBranch);
    expect(first).not.toBeNull();

    const second = await createWorktree(task, mainBranch);
    expect(second).not.toBeNull();
    expect(second!.path).toBe(first!.path);

    trackCleanup(first!.path, first!.branch);
  });

  test('修改文件后检测未提交变更', async () => {
    const task = createTestTask();
    const mainBranch = await getMainBranch();

    const result = await createWorktree(task, mainBranch);
    expect(result).not.toBeNull();
    trackCleanup(result!.path, result!.branch);

    writeFileSync(join(result!.path, 'e2e-test-new-file.ts'), '// new file\n');
    const hasChanges = await hasUncommittedChanges(result!.path);
    expect(hasChanges).toBe(true);
  });

  test('提交变更', async () => {
    const task = createTestTask();
    const mainBranch = await getMainBranch();

    const result = await createWorktree(task, mainBranch);
    expect(result).not.toBeNull();
    trackCleanup(result!.path, result!.branch);

    writeFileSync(join(result!.path, 'e2e-test-commit.ts'), '// committed\n');
    const success = await commitChanges('test(e2e): add file', result!.path);
    expect(success).toBe(true);

    const hasChanges = await hasUncommittedChanges(result!.path);
    expect(hasChanges).toBe(false);
  });

  test('获取 diff 和变更文件列表', async () => {
    const task = createTestTask();
    const mainBranch = await getMainBranch();

    const result = await createWorktree(task, mainBranch);
    expect(result).not.toBeNull();
    trackCleanup(result!.path, result!.branch);

    writeFileSync(join(result!.path, 'e2e-test-diff.ts'), '// diff test\n');
    await commitChanges('test(e2e): diff test', result!.path);

    const diff = await getDiff(result!.branch, mainBranch, result!.path);
    expect(diff).toContain('e2e-test-diff.ts');

    const files = await getChangedFiles(result!.branch, mainBranch, result!.path);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => f.includes('e2e-test-diff.ts'))).toBe(true);
  });

  test('删除 worktree', async () => {
    const task = createTestTask();
    const mainBranch = await getMainBranch();

    const result = await createWorktree(task, mainBranch);
    expect(result).not.toBeNull();
    expect(existsSync(result!.path)).toBe(true);

    const removed = await removeWorktree(result!.path);
    expect(removed).toBe(true);
    expect(existsSync(result!.path)).toBe(false);

    await deleteBranch(result!.branch);
  });

  test('合并分支后删除', async () => {
    const task = createTestTask();
    const mainBranch = await getMainBranch();

    const result = await createWorktree(task, mainBranch);
    expect(result).not.toBeNull();

    // 修改并提交
    writeFileSync(join(result!.path, 'e2e-test-merge.ts'), '// merge test\n');
    await commitChanges('test(e2e): merge test', result!.path);

    // 删除 worktree
    await removeWorktree(result!.path);

    // Stash 未提交变更以避免 checkout 失败
    const stashed = Bun.spawnSync(['git', 'stash', '--include-untracked'], { cwd: projectDir });

    try {
      // 合并
      const mergeResult = await mergeBranch(result!.branch, mainBranch);
      expect(mergeResult.success).toBe(true);

      // 还原合并（用 reset 回到合并前的 HEAD）
      Bun.spawnSync(['git', 'reset', '--hard', `HEAD^`], { cwd: projectDir });

      // 删除分支
      await deleteBranch(result!.branch);
    } finally {
      // 恢复 stash
      if (stashed.exitCode === 0) {
        Bun.spawnSync(['git', 'stash', 'pop'], { cwd: projectDir });
      }
    }
  });

  test('完整 worktree 流程：创建 → 修改 → 提交 → diff → 合并 → 清理', async () => {
    const task = createTestTask({ description: 'Full flow test' });
    const mainBranch = await getMainBranch();

    // 1. 创建
    const result = await createWorktree(task, mainBranch);
    expect(result).not.toBeNull();
    expect(existsSync(result!.path)).toBe(true);

    // 2. 修改
    writeFileSync(join(result!.path, 'e2e-test-full-flow.ts'), '// full flow\n');
    expect(await hasUncommittedChanges(result!.path)).toBe(true);

    // 3. 提交
    expect(await commitChanges('test(e2e): full flow', result!.path)).toBe(true);

    // 4. diff
    const diff = await getDiff(result!.branch, mainBranch, result!.path);
    expect(diff).toContain('e2e-test-full-flow.ts');

    const files = await getChangedFiles(result!.branch, mainBranch, result!.path);
    expect(files.some(f => f.includes('e2e-test-full-flow.ts'))).toBe(true);

    // 5. 删除 worktree
    expect(await removeWorktree(result!.path)).toBe(true);

    // 6. 合并（先 stash 保护未提交变更）
    const stashed = Bun.spawnSync(['git', 'stash', '--include-untracked'], { cwd: projectDir });
    try {
      const merged = await mergeBranch(result!.branch, mainBranch);
      expect(merged.success).toBe(true);

      // 还原合并
      Bun.spawnSync(['git', 'reset', '--hard', 'HEAD^'], { cwd: projectDir });

      // 7. 删除分支
      expect(await deleteBranch(result!.branch)).toBe(true);
    } finally {
      if (stashed.exitCode === 0) {
        Bun.spawnSync(['git', 'stash', 'pop'], { cwd: projectDir });
      }
    }
  });
});
