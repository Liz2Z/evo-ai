import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { runGit } from '../../src/utils/git'

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
})
