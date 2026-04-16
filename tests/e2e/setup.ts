import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let testDir: string
let dataDir: string

/**
 * 初始化测试环境：创建临时目录和 git repo
 */
export async function setupTestEnv(): Promise<{ testDir: string; dataDir: string }> {
  testDir = join(tmpdir(), `evo-ai-test-${Date.now()}`)
  dataDir = join(testDir, '.evo-ai', '.data')

  // 创建临时目录
  await mkdir(testDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(join(testDir, '.evo-ai'), { recursive: true })
  await mkdir(join(testDir, '.worktrees'), { recursive: true })
  await writeFile(
    join(testDir, '.evo-ai', 'config.json'),
    JSON.stringify(
      {
        heartbeatInterval: 30000,
        maxConcurrency: 3,
        maxRetryAttempts: 3,
        worktreesDir: '.worktrees',
        developBranch: 'main',
        models: {
          lite: 'haiku',
          pro: 'sonnet',
          max: 'opus',
        },
        provider: {
          apiKey: process.env.ANTHROPIC_API_KEY || '',
          baseUrl: process.env.ANTHROPIC_BASE_URL || '',
        },
        manager: {
          runtimeMode: 'hybrid',
        },
      },
      null,
      2,
    ),
  )

  // 初始化 git repo
  await runCmd('git', ['init'], testDir)
  await runCmd('git', ['checkout', '-b', 'main'], testDir)
  await runCmd('git', ['config', 'user.email', 'test@evo-ai.dev'], testDir)
  await runCmd('git', ['config', 'user.name', 'Evo AI Test'], testDir)

  // 创建初始文件并提交
  await writeFile(join(testDir, 'README.md'), '# Test Project\n')
  await writeFile(join(testDir, 'src'), '')
  await runCmd('git', ['add', '-A'], testDir)
  await runCmd('git', ['commit', '-m', 'Initial commit'], testDir)

  return { testDir, dataDir }
}

/**
 * 清理测试环境
 */
export async function teardownTestEnv(): Promise<void> {
  // 清理临时目录
  if (testDir && existsSync(testDir)) {
    await rm(testDir, { recursive: true, force: true })
  }
}

/**
 * 获取当前测试目录
 */
export function getTestDir(): string {
  return testDir
}

/**
 * 获取当前 data 目录
 */
export function getDataDir(): string {
  return dataDir
}

function runCmd(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawnSync([cmd, ...args], { cwd })
    if (proc.exitCode === 0) {
      resolve()
    } else {
      reject(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${proc.stderr.toString()}`))
    }
  })
}
