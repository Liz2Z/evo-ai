import { existsSync } from 'fs';
import { join } from 'path';
import type { Task } from '../types';

export async function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: cwd || process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
    exitCode: proc.exitCode,
  };
}

export async function isGitRepo(): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree']);
  return result.exitCode === 0 && result.stdout === 'true';
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return result.stdout;
}

export async function getDevelopBranch(): Promise<string> {
  // Try common develop branch names
  const branches = ['develop', 'main', 'master'];
  for (const branch of branches) {
    const result = await runGit(['rev-parse', '--verify', branch]);
    if (result.exitCode === 0) return branch;
  }
  return 'main';
}

function sanitizeSlug(input: string, maxLen = 40): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'task';
}

async function findExistingTaskWorktree(taskId: string): Promise<string | null> {
  const branchName = `task/${taskId}`;
  const result = await runGit(['worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0) return null;

  const lines = result.stdout.split('\n');
  let currentPath = '';

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      currentPath = line.replace('worktree ', '').trim();
      continue;
    }
    if (line.startsWith('branch refs/heads/')) {
      const branch = line.replace('branch refs/heads/', '').trim();
      if (branch === branchName && currentPath) {
        return currentPath;
      }
    }
  }

  return null;
}

function shortStableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

export async function createWorktree(
  task: Task,
  baseBranch: string,
  semanticTitle?: string
): Promise<{ path: string; branch: string } | null> {
  const branchName = `task/${task.id}`;
  const existing = await findExistingTaskWorktree(task.id);
  if (existing) {
    return { path: existing, branch: branchName };
  }

  const titleSlug = sanitizeSlug(semanticTitle || task.description || task.id);
  const timestamp = Date.now().toString(36);
  const hash = shortStableHash(task.id);
  // Naming rule: semantic first, followed by timestamp and hash
  const worktreeName = `${titleSlug}-${timestamp}-${hash}`;
  const worktreePath = join(process.cwd(), '.worktrees', worktreeName);

  // Create worktree with new branch
  const result = await runGit([
    'worktree', 'add', '-b', branchName,
    worktreePath,
    baseBranch
  ]);

  if (result.exitCode !== 0) {
    // Try without creating new branch if branch might exist
    const retryResult = await runGit([
      'worktree', 'add', worktreePath, branchName
    ]);
    if (retryResult.exitCode !== 0) {
      return null;
    }
  }

  return { path: worktreePath, branch: branchName };
}

export async function removeWorktree(worktreePath: string): Promise<boolean> {
  const result = await runGit(['worktree', 'remove', '--force', worktreePath]);
  return result.exitCode === 0;
}

export async function getDiff(branch: string, baseBranch: string, cwd?: string): Promise<string> {
  const result = await runGit(['diff', `${baseBranch}...${branch}`], cwd);
  return result.stdout;
}

export async function getChangedFiles(branch: string, baseBranch: string, cwd?: string): Promise<string[]> {
  const result = await runGit(['diff', '--name-only', `${baseBranch}...${branch}`], cwd);
  if (!result.stdout) return [];
  return result.stdout.split('\n').filter(f => f.trim());
}

export async function commitChanges(message: string, cwd?: string): Promise<boolean> {
  // Stage all changes
  await runGit(['add', '-A'], cwd);
  // Commit
  const result = await runGit(['commit', '-m', message], cwd);
  return result.exitCode === 0;
}

export async function mergeBranch(branch: string, baseBranch: string): Promise<{ success: boolean; message: string }> {
  // Switch to base branch
  const checkoutResult = await runGit(['checkout', baseBranch]);
  if (checkoutResult.exitCode !== 0) {
    return { success: false, message: checkoutResult.stderr };
  }

  // Merge
  const mergeResult = await runGit(['merge', '--no-ff', branch, '-m', `Merge ${branch}`]);
  if (mergeResult.exitCode !== 0) {
    return { success: false, message: mergeResult.stderr };
  }

  return { success: true, message: `Merged ${branch} into ${baseBranch}` };
}

export async function deleteBranch(branch: string): Promise<boolean> {
  const result = await runGit(['branch', '-D', branch]);
  return result.exitCode === 0;
}

export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain'], cwd);
  return result.stdout.length > 0;
}

export async function getRepoStatus(): Promise<{
  branch: string;
  hasChanges: boolean;
  worktrees: string[];
}> {
  const branch = await getCurrentBranch();
  const hasChanges = await hasUncommittedChanges();

  const worktreeResult = await runGit(['worktree', 'list']);
  const worktrees = worktreeResult.stdout
    .split('\n')
    .filter(line => line.includes('.worktrees'))
    .map(line => line.split(/\s+/)[0]);

  return { branch, hasChanges, worktrees };
}

export async function listWorktrees(): Promise<string[]> {
  const result = await runGit(['worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.replace('worktree ', ''));
}
