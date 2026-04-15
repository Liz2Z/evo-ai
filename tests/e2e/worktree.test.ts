import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  commitAllChanges,
  deleteBranch,
  ensureMissionWorkspace,
  getUncommittedChangedFiles,
  getUncommittedDiff,
  hasUncommittedChanges,
  removeWorktree,
} from '../../src/utils/git'
import { setupTestEnv, teardownTestEnv } from './setup'

let testDir: string
let workspace: { path: string; branch: string } | null = null
const mission = 'E2E mission workspace test'

beforeAll(async () => {
  const env = await setupTestEnv()
  testDir = env.testDir
  process.chdir(testDir)
})

afterAll(async () => {
  if (workspace) {
    if (existsSync(workspace.path)) {
      await removeWorktree(workspace.path).catch(() => {})
    }
    await deleteBranch(workspace.branch).catch(() => {})
  }
  await teardownTestEnv()
})

describe('Mission workspace', () => {
  test('ensureMissionWorkspace 幂等并返回同一 worktree', async () => {
    const first = await ensureMissionWorkspace(mission, 'main')
    const second = await ensureMissionWorkspace(mission, 'main')

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first?.path).toBe(second?.path)
    expect(first?.branch).toBe(second?.branch)
    expect(existsSync(first?.path)).toBe(true)
    workspace = first
  })

  test('提交前能读取未提交 diff 和 changed files', async () => {
    workspace = workspace || (await ensureMissionWorkspace(mission, 'main'))
    if (!workspace) throw new Error('workspace not created')

    await writeFile(join(workspace.path, 'mission-e2e.txt'), 'mission workspace\n')

    expect(await hasUncommittedChanges(workspace.path)).toBe(true)
    const diff = await getUncommittedDiff(workspace.path)
    const files = await getUncommittedChangedFiles(workspace.path)

    expect(diff).toContain('mission-e2e.txt')
    expect(files).toContain('mission-e2e.txt')
  })

  test('commitAllChanges 提交后工作区恢复干净', async () => {
    workspace = workspace || (await ensureMissionWorkspace(mission, 'main'))
    if (!workspace) throw new Error('workspace not created')

    const result = await commitAllChanges('task(test): commit mission workspace', workspace.path)
    expect(result.success).toBe(true)
    expect(await hasUncommittedChanges(workspace.path)).toBe(false)
  })
})
