import { join } from 'node:path'

const FALLBACK_GIT_PATHS = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']
let cachedGitBinary: string | null = null

type GitExecResult = { stdout: string; stderr: string; exitCode: number; spawnError?: string }

function execGitWithBinary(gitBinary: string, args: string[], cwd?: string): GitExecResult | null {
  try {
    const proc = Bun.spawnSync([gitBinary, ...args], {
      cwd: cwd || process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    return {
      stdout: proc.stdout.toString().trim(),
      stderr: proc.stderr.toString().trim(),
      exitCode: proc.exitCode,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('ENOENT')) return null
    return {
      stdout: '',
      stderr: '',
      exitCode: 127,
      spawnError: message,
    }
  }
}

function candidateGitBinaries(): string[] {
  const candidates = [
    process.env.EVO_AI_GIT_BIN,
    cachedGitBinary,
    'git',
    ...FALLBACK_GIT_PATHS,
  ].filter((item): item is string => Boolean(item?.trim()))
  return [...new Set(candidates)]
}

export async function runGit(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let lastSpawnError = ''

  for (const gitBinary of candidateGitBinaries()) {
    const result = execGitWithBinary(gitBinary, args, cwd)
    if (result === null) continue
    cachedGitBinary = gitBinary
    if (result.spawnError) lastSpawnError = result.spawnError
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  }

  return {
    stdout: '',
    stderr:
      lastSpawnError ||
      `Unable to execute git. Tried: ${candidateGitBinaries().join(', ')}. PATH=${process.env.PATH || '(empty)'}`,
    exitCode: 127,
  }
}

export async function isGitRepo(): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'])
  return result.exitCode === 0 && result.stdout === 'true'
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  return result.stdout
}

export async function branchExists(branch: string, cwd?: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', branch], cwd)
  return result.exitCode === 0
}

function sanitizeSlug(input: string, maxLen = 48): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen) || 'mission'
  )
}

function shortStableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 6)
}

async function findWorktreeByBranch(branchName: string): Promise<string | null> {
  const result = await runGit(['worktree', 'list', '--porcelain'])
  if (result.exitCode !== 0) return null

  const lines = result.stdout.split('\n')
  let currentPath = ''

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      currentPath = line.replace('worktree ', '').trim()
      continue
    }
    if (line.startsWith('branch refs/heads/')) {
      const branch = line.replace('branch refs/heads/', '').trim()
      if (branch === branchName && currentPath) {
        return currentPath
      }
    }
  }

  return null
}

async function getUntrackedFiles(cwd?: string): Promise<string[]> {
  const result = await runGit(['ls-files', '--others', '--exclude-standard'], cwd)
  return result.stdout.split('\n').filter(Boolean)
}

export async function ensureMissionWorkspace(
  mission: string,
  baseBranch: string,
  worktreesDir = '.worktrees',
): Promise<{ path: string; branch: string } | null> {
  const slug = sanitizeSlug(mission, 36)
  const branchName = `mission/${slug}-${shortStableHash(mission)}`
  const existing = await findWorktreeByBranch(branchName)
  if (existing) {
    return { path: existing, branch: branchName }
  }

  const worktreeName = `${slug}-${shortStableHash(branchName)}`
  const worktreePath = join(process.cwd(), worktreesDir, worktreeName)
  const createResult = await runGit(['worktree', 'add', '-b', branchName, worktreePath, baseBranch])
  if (createResult.exitCode === 0) {
    return { path: worktreePath, branch: branchName }
  }

  const retryResult = await runGit(['worktree', 'add', worktreePath, branchName])
  if (retryResult.exitCode !== 0) return null
  return { path: worktreePath, branch: branchName }
}

export async function removeWorktree(worktreePath: string): Promise<boolean> {
  const result = await runGit(['worktree', 'remove', '--force', worktreePath])
  return result.exitCode === 0
}

export async function deleteBranch(branch: string): Promise<boolean> {
  const result = await runGit(['branch', '-D', branch])
  return result.exitCode === 0
}

export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain'], cwd)
  return result.stdout.length > 0
}

export async function getUncommittedDiff(cwd?: string): Promise<string> {
  const parts: string[] = []
  const staged = await runGit(['diff', '--cached', '--no-ext-diff'], cwd)
  if (staged.stdout) parts.push(staged.stdout)

  const unstaged = await runGit(['diff', '--no-ext-diff'], cwd)
  if (unstaged.stdout) parts.push(unstaged.stdout)

  const untracked = await getUntrackedFiles(cwd)
  for (const file of untracked) {
    const result = await runGit(['diff', '--no-index', '--', '/dev/null', file], cwd)
    if (result.stdout) parts.push(result.stdout)
  }

  return parts.filter(Boolean).join('\n')
}

export async function getUncommittedChangedFiles(cwd?: string): Promise<string[]> {
  const cached = await runGit(['diff', '--cached', '--name-only'], cwd)
  const unstaged = await runGit(['diff', '--name-only'], cwd)
  const untracked = await getUntrackedFiles(cwd)
  return [
    ...new Set(
      [...cached.stdout.split('\n'), ...unstaged.stdout.split('\n'), ...untracked].filter(Boolean),
    ),
  ]
}

export async function commitAllChanges(
  message: string,
  cwd?: string,
): Promise<{ success: boolean; message: string }> {
  await runGit(['add', '-A'], cwd)
  const status = await hasUncommittedChanges(cwd)
  if (!status) {
    return { success: false, message: 'No changes to commit' }
  }
  const result = await runGit(['commit', '-m', message], cwd)
  if (result.exitCode !== 0) {
    return { success: false, message: result.stderr || result.stdout || 'Commit failed' }
  }
  return { success: true, message: result.stdout || 'Commit created' }
}

export async function listWorktrees(): Promise<string[]> {
  const result = await runGit(['worktree', 'list', '--porcelain'])
  if (result.exitCode !== 0) return []
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.replace('worktree ', ''))
}

export async function getRepoStatus(): Promise<{
  branch: string
  hasChanges: boolean
  worktrees: string[]
}> {
  const branch = await getCurrentBranch()
  const hasChanges = await hasUncommittedChanges()
  const worktrees = await listWorktrees()
  return { branch, hasChanges, worktrees }
}
