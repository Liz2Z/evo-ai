import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testDir: string;
let dataDir: string;
let originalDataDir: string | undefined;

/**
 * 初始化测试环境：创建临时目录和 git repo
 */
export async function setupTestEnv(): Promise<{ testDir: string; dataDir: string }> {
  testDir = join(tmpdir(), `evo-ai-test-${Date.now()}`);
  dataDir = join(testDir, 'data');

  // 创建临时目录
  await mkdir(testDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(testDir, '.worktrees'), { recursive: true });

  // 初始化 git repo
  await runCmd('git', ['init'], testDir);
  await runCmd('git', ['config', 'user.email', 'test@evo-ai.dev'], testDir);
  await runCmd('git', ['config', 'user.name', 'Evo AI Test'], testDir);

  // 创建初始文件并提交
  await writeFile(join(testDir, 'README.md'), '# Test Project\n');
  await writeFile(join(testDir, 'src'), '');
  await runCmd('git', ['add', '-A'], testDir);
  await runCmd('git', ['commit', '-m', 'Initial commit'], testDir);

  // 设置 DATA_DIR 环境变量
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  return { testDir, dataDir };
}

/**
 * 清理测试环境
 */
export async function teardownTestEnv(): Promise<void> {
  // 恢复环境变量
  if (originalDataDir !== undefined) {
    process.env.DATA_DIR = originalDataDir;
  } else {
    delete process.env.DATA_DIR;
  }

  // 清理临时目录
  if (testDir && existsSync(testDir)) {
    await rm(testDir, { recursive: true, force: true });
  }
}

/**
 * 获取当前测试目录
 */
export function getTestDir(): string {
  return testDir;
}

/**
 * 获取当前 data 目录
 */
export function getDataDir(): string {
  return dataDir;
}

function runCmd(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawnSync([cmd, ...args], { cwd });
    if (proc.exitCode === 0) {
      resolve();
    } else {
      reject(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${proc.stderr.toString()}`));
    }
  });
}
