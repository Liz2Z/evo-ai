import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadResolvedConfigFromPaths, resolveStartupMission } from '../../src/config';
import { getRuntimeDataDir } from '../../src/runtime/paths';
import { loadMasterState, saveMasterState } from '../../src/utils/storage';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  process.chdir(originalCwd);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('配置解析', () => {
  test('本地配置会深合并覆盖 XDG 配置', async () => {
    const repoDir = await makeTempDir('evo-ai-config-local');
    const xdgDir = await makeTempDir('evo-ai-config-xdg');
    await mkdir(join(repoDir, '.evo-ai'), { recursive: true });
    await mkdir(join(xdgDir, '.evo-ai'), { recursive: true });

    await writeFile(join(xdgDir, '.evo-ai', 'config.json'), JSON.stringify({
      maxConcurrency: 5,
      models: {
        lite: 'global-lite',
        max: 'global-max',
      },
      provider: {
        baseUrl: 'https://global.example.com',
      },
    }, null, 2));

    await writeFile(join(repoDir, '.evo-ai', 'config.json'), JSON.stringify({
      heartbeatInterval: 1000,
      models: {
        pro: 'local-pro',
      },
      provider: {
        apiKey: 'local-key',
      },
    }, null, 2));

    const config = await loadResolvedConfigFromPaths({
      globalConfigPath: join(xdgDir, '.evo-ai', 'config.json'),
      localConfigPath: join(repoDir, '.evo-ai', 'config.json'),
    });

    expect(config.heartbeatInterval).toBe(1000);
    expect(config.maxConcurrency).toBe(5);
    expect(config.developBranch).toBe('main');
    expect(config.models).toEqual({
      lite: 'global-lite',
      pro: 'local-pro',
      max: 'global-max',
    });
    expect(config.provider).toEqual({
      apiKey: 'local-key',
      baseUrl: 'https://global.example.com',
    });
  });

  test('mission 解析优先 CLI，其次已保存状态', () => {
    expect(resolveStartupMission('saved mission', undefined)).toBe('saved mission');
    expect(resolveStartupMission('saved mission', 'cli mission')).toBe('cli mission');
    expect(() => resolveStartupMission('', '')).toThrow('Mission is required');
  });

  test('运行态状态默认写入 .evo-ai/.data', async () => {
    const repoDir = await makeTempDir('evo-ai-runtime');
    process.chdir(repoDir);

    await saveMasterState({
      mission: 'runtime mission',
      currentPhase: 'idle',
      lastHeartbeat: '',
      lastInspection: '',
      activeSince: new Date().toISOString(),
      pendingQuestions: [],
    });

    const defaultMasterFile = join(repoDir, '.evo-ai', '.data', 'master.json');
    expect(getRuntimeDataDir().endsWith(join('.evo-ai', '.data'))).toBe(true);
    expect(existsSync(defaultMasterFile)).toBe(true);
    expect((await loadMasterState()).mission).toBe('runtime mission');
  });
});
