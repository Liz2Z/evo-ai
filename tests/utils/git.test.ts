import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getUncommittedDiff, runGit } from '../../src/utils/git'

describe('git utils', () => {
  test('PATH 为空时仍能找到 git 可执行文件', async () => {
    const hasFallbackGit = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'].some(
      (path) => existsSync(path),
    )
    if (!hasFallbackGit) {
      expect(true).toBe(true)
      return
    }

    const originalPath = process.env.PATH
    process.env.PATH = ''

    try {
      const result = await runGit(['--version'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toLowerCase()).toContain('git version')
    } finally {
      process.env.PATH = originalPath
    }
  })

  describe('getUncommittedDiff', () => {
    const originalCwd = process.cwd()
    const repoDir = join(tmpdir(), `evo-ai-git-test-${Date.now()}`)

    beforeAll(async () => {
      mkdirSync(repoDir, { recursive: true })
      process.chdir(repoDir)
      await runGit(['init'])
      await runGit(['checkout', '-b', 'main'])
      await runGit(['config', 'user.email', 'test@evo-ai.dev'])
      await runGit(['config', 'user.name', 'Evo AI Test'])
      await Bun.write(join(repoDir, 'tracked.txt'), 'initial\n')
      await runGit(['add', 'tracked.txt'])
      await runGit(['commit', '-m', 'initial'])
    })

    afterAll(() => {
      process.chdir(originalCwd)
      rmSync(repoDir, { recursive: true, force: true })
    })

    test('会跳过包含空字节的未跟踪二进制文件', async () => {
      await Bun.write(join(repoDir, 'tracked.txt'), 'changed\n')
      await Bun.write(join(repoDir, 'binary.dat'), new Uint8Array([0, 1, 2, 3, 255]))

      const diff = await getUncommittedDiff(repoDir)

      expect(diff).toContain('changed')
      expect(diff).not.toContain('binary.dat')
      expect(diff).not.toContain('Binary files')
    })
  })
})
