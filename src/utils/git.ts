import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadManagerState, loadMissionHistory } from './storage'

const FALLBACK_GIT_PATHS = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']
let cachedGitBinary: string | null = null
const PROTECTED_INTEGRATION_BRANCHES = new Set(['main', 'manager', 'develop', 'dev'])

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

function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '').trim()
}

export function isProtectedIntegrationBranch(branch: string): boolean {
  return PROTECTED_INTEGRATION_BRANCHES.has(normalizeBranchName(branch))
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
  const branchAlreadyExists = await branchExists(branchName)
  const createResult = branchAlreadyExists
    ? { exitCode: 1 }
    : await runGit(['worktree', 'add', '-b', branchName, worktreePath, baseBranch])
  if (createResult.exitCode === 0) {
    return { path: worktreePath, branch: branchName }
  }

  if (!branchAlreadyExists) {
    if (existsSync(worktreePath)) {
      await runGit(['worktree', 'remove', '--force', worktreePath])
    }

    if (await branchExists(branchName)) {
      await deleteBranch(branchName)
    }
  }

  const retryResult = await runGit(['worktree', 'add', worktreePath, branchName])
  if (retryResult.exitCode !== 0) {
    if (existsSync(worktreePath)) {
      await runGit(['worktree', 'remove', '--force', worktreePath])
    }
    return null
  }
  return { path: worktreePath, branch: branchName }
}

export interface MissionWorkspaceBranchValidationResult {
  valid: boolean
  currentBranch?: string
  message: string
}

export async function validateMissionWorkspaceBranch(
  worktreePath: string,
  expectedBranch: string,
): Promise<MissionWorkspaceBranchValidationResult> {
  if (!existsSync(worktreePath)) {
    return {
      valid: false,
      message: `Mission worktree does not exist: ${worktreePath}`,
    }
  }

  const currentBranch = normalizeBranchName(await getCurrentBranch(worktreePath))
  const normalizedExpectedBranch = normalizeBranchName(expectedBranch)

  if (!currentBranch) {
    return {
      valid: false,
      message: 'Unable to determine current branch for mission worktree',
    }
  }

  if (currentBranch !== normalizedExpectedBranch) {
    return {
      valid: false,
      currentBranch,
      message: `Mission worktree branch mismatch. Expected ${normalizedExpectedBranch}, got ${currentBranch}`,
    }
  }

  if (isProtectedIntegrationBranch(currentBranch)) {
    return {
      valid: false,
      currentBranch,
      message: `Mission worktree is on protected integration branch: ${currentBranch}`,
    }
  }

  return {
    valid: true,
    currentBranch,
    message: `Mission worktree branch verified: ${currentBranch}`,
  }
}

export interface WorktreeMissionAssociation {
  mission: string
  source: 'manager' | 'history' | 'local'
}

function normalizeWorktreePath(worktreePath: string): string {
  return resolve(worktreePath)
}

async function readLocalWorktreeMission(worktreePath: string): Promise<string | null> {
  const masterStateFile = join(worktreePath, '.evo-ai', '.data', 'manager.json')
  if (!existsSync(masterStateFile)) return null

  try {
    const parsed = (await Bun.file(masterStateFile).json()) as { mission?: unknown }
    return typeof parsed.mission === 'string' && parsed.mission.trim()
      ? parsed.mission.trim()
      : null
  } catch {
    return null
  }
}

export async function getWorktreeMissionAssociations(
  worktreePath: string,
): Promise<WorktreeMissionAssociation[]> {
  const normalizedPath = normalizeWorktreePath(worktreePath)
  const associations = new Map<string, WorktreeMissionAssociation>()

  const masterState = await loadManagerState()
  if (
    masterState.missionWorktree &&
    normalizeWorktreePath(masterState.missionWorktree) === normalizedPath &&
    masterState.mission.trim()
  ) {
    associations.set(`manager:${masterState.mission}`, {
      mission: masterState.mission,
      source: 'manager',
    })
  }

  const missionHistory = await loadMissionHistory()
  for (const entry of missionHistory) {
    if (!entry.worktreePath || normalizeWorktreePath(entry.worktreePath) !== normalizedPath)
      continue
    if (!entry.mission.trim()) continue
    associations.set(`history:${entry.mission}`, {
      mission: entry.mission,
      source: 'history',
    })
  }

  const localMission = await readLocalWorktreeMission(normalizedPath)
  if (localMission) {
    associations.set(`local:${localMission}`, {
      mission: localMission,
      source: 'local',
    })
  }

  return [...associations.values()]
}

export async function removeWorktree(
  worktreePath: string,
  options?: { allowAssociated?: boolean },
): Promise<boolean> {
  if (!options?.allowAssociated) {
    const associations = await getWorktreeMissionAssociations(worktreePath)
    if (associations.length > 0) return false
  }

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

async function hasTrackedUncommittedChanges(cwd?: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain', '--untracked-files=no'], cwd)
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
    const filePath = cwd ? join(cwd, file) : file
    if (!existsSync(filePath)) continue

    try {
      const sample = readFileSync(filePath)
      if (sample.subarray(0, 8192).includes(0)) {
        continue
      }
    } catch {
      continue
    }

    const result = await runGit(['diff', '--no-index', '--', '/dev/null', file], cwd)
    if (result.stdout && !result.stdout.includes('Binary files')) {
      parts.push(result.stdout)
    }
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

export async function mergeBranchIntoBase(
  sourceBranch: string,
  baseBranch: string,
  cwd?: string,
): Promise<{ success: boolean; message: string }> {
  const currentBranch = normalizeBranchName(await getCurrentBranch(cwd))
  const normalizedBaseBranch = normalizeBranchName(baseBranch)

  if (!currentBranch) {
    return { success: false, message: 'Unable to determine current branch before mission merge' }
  }

  if (currentBranch !== normalizedBaseBranch) {
    return {
      success: false,
      message: `Repository is on ${currentBranch}. Expected ${normalizedBaseBranch} before mission merge.`,
    }
  }

  if (await hasTrackedUncommittedChanges(cwd)) {
    return {
      success: false,
      message: `Repository has tracked uncommitted changes on ${normalizedBaseBranch}. Mission merge requires a clean integration branch.`,
    }
  }

  const result = await runGit(['merge', '--no-ff', '--no-edit', sourceBranch], cwd)
  if (result.exitCode === 0) {
    return { success: true, message: result.stdout || 'Mission branch merged successfully' }
  }

  await runGit(['merge', '--abort'], cwd)
  return {
    success: false,
    message: result.stderr || result.stdout || `Failed to merge ${sourceBranch} into ${baseBranch}`,
  }
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
