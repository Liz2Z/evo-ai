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

export async function createWorktree(task: Task, baseBranch: string): Promise<{ path: string; branch: string } | null> {
  const worktreeName = `task-${task.id}`;
  const branchName = `task/${task.id}`;
  const worktreePath = join(process.cwd(), '.worktrees', worktreeName);

  if (existsSync(worktreePath)) {
    console.log(`Worktree already exists: ${worktreePath}`);
    return { path: worktreePath, branch: branchName };
  }

  // Create worktree with new branch
  const result = await runGit([
    'worktree', 'add', '-b', branchName,
    worktreePath,
    baseBranch
  ]);

  if (result.exitCode !== 0) {
    console.error(`Failed to create worktree: ${result.stderr}`);
    // Try without creating new branch if branch might exist
    const retryResult = await runGit([
      'worktree', 'add', worktreePath, branchName
    ]);
    if (retryResult.exitCode !== 0) {
      console.error(`Retry failed: ${retryResult.stderr}`);
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
