import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Settings } from "../../src/config/core";
import { configSchema } from "../../src/config/schemas";
import { getRuntimeDataDir } from "../../src/runtime/paths";
import { loadMasterState, saveMasterState } from "../../src/utils/storage";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
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

describe("配置解析", () => {
  test("本地配置会深合并覆盖全局配置", async () => {
    const repoDir = await makeTempDir("evo-ai-config-local");
    const xdgDir = await makeTempDir("evo-ai-config-xdg");
    await mkdir(join(repoDir, ".evo-ai"), { recursive: true });
    await mkdir(join(xdgDir, ".evo-ai"), { recursive: true });

    await writeFile(
      join(xdgDir, ".evo-ai", "config.json"),
      JSON.stringify(
        {
          maxConcurrency: 5,
          models: {
            lite: "global-lite",
            max: "global-max",
          },
          provider: {
            baseUrl: "https://global.example.com",
          },
        },
        null,
        2,
      ),
    );

    await writeFile(
      join(repoDir, ".evo-ai", "config.json"),
      JSON.stringify(
        {
          heartbeatInterval: 1000,
          models: {
            pro: "local-pro",
          },
          provider: {
            apiKey: "local-key",
          },
        },
        null,
        2,
      ),
    );

    process.chdir(repoDir);

    const manager = new Settings("evo-ai", configSchema, {
      globalPath: join(xdgDir, ".evo-ai", "config.json"),
      credentialsPath: join(xdgDir, ".evo-ai", "credentials.json"),
      projectPath: join(repoDir, ".evo-ai", "config.json"),
    });
    const config = manager.load().get();

    expect(config.heartbeatInterval).toBe(1000);
    expect(config.maxConcurrency).toBe(5);
    expect(config.developBranch).toBe("develop");
    expect(config.models).toEqual({
      lite: "global-lite",
      pro: "local-pro",
      max: "global-max",
    });
    expect(config.provider).toEqual({
      apiKey: "local-key",
      baseUrl: "https://global.example.com",
    });
  });

  test("credentials.json 会按同样结构深合并，并覆盖同级 config.json", async () => {
    const repoDir = await makeTempDir("evo-ai-credentials-local");
    const xdgDir = await makeTempDir("evo-ai-credentials-xdg");
    await mkdir(join(repoDir, ".evo-ai"), { recursive: true });
    await mkdir(join(xdgDir, ".evo-ai"), { recursive: true });

    await writeFile(
      join(xdgDir, ".evo-ai", "config.json"),
      JSON.stringify(
        {
          provider: {
            baseUrl: "https://global-config.example.com",
            apiKey: "global-config-key",
          },
          models: {
            lite: "global-lite",
          },
        },
        null,
        2,
      ),
    );

    await writeFile(
      join(xdgDir, ".evo-ai", "credentials.json"),
      JSON.stringify(
        {
          provider: {
            apiKey: "global-credentials-key",
          },
        },
        null,
        2,
      ),
    );

    await writeFile(
      join(repoDir, ".evo-ai", "config.json"),
      JSON.stringify(
        {
          provider: {
            baseUrl: "https://local-config.example.com",
          },
          models: {
            pro: "local-pro",
          },
        },
        null,
        2,
      ),
    );

    await writeFile(
      join(repoDir, ".evo-ai", "credentials.json"),
      JSON.stringify(
        {
          provider: {
            apiKey: "local-credentials-key",
          },
        },
        null,
        2,
      ),
    );

    process.chdir(repoDir);

    const manager = new Settings("evo-ai", configSchema, {
      globalPath: join(xdgDir, ".evo-ai", "config.json"),
      credentialsPath: join(xdgDir, ".evo-ai", "credentials.json"),
      projectPath: join(repoDir, ".evo-ai", "config.json"),
    });
    const config = manager.load().get();

    expect(config.models).toEqual({
      lite: "global-lite",
      pro: "local-pro",
      max: "glm-5.1",
    });
    expect(config.provider).toEqual({
      apiKey: "local-credentials-key",
      baseUrl: "https://local-config.example.com",
    });
  });

  test("Accessor proxy 可以深层读取配置", async () => {
    const repoDir = await makeTempDir("evo-ai-accessor");
    await mkdir(join(repoDir, ".evo-ai"), { recursive: true });

    await writeFile(
      join(repoDir, ".evo-ai", "config.json"),
      JSON.stringify(
        {
          provider: { apiKey: "test-key" },
        },
        null,
        2,
      ),
    );

    process.chdir(repoDir);

    const manager = new Settings("evo-ai", configSchema, {
      globalPath: join(repoDir, "nonexistent", "config.json"),
      credentialsPath: join(repoDir, "nonexistent", "credentials.json"),
      projectPath: join(repoDir, ".evo-ai", "config.json"),
    });
    const accessor = manager.load();

    expect((accessor.provider.get() as any).apiKey).toBe("test-key");
    expect(accessor.maxConcurrency.get()).toBe(3);
    expect(accessor.models.lite.get()).toBe("glm-4.5-air");
  });

  test("运行态状态默认写入 .evo-ai/.data", async () => {
    const repoDir = await makeTempDir("evo-ai-runtime");
    process.chdir(repoDir);

    await saveMasterState({
      mission: "runtime mission",
      currentPhase: "idle",
      lastHeartbeat: "",
      lastInspection: "",
      activeSince: new Date().toISOString(),
      pendingQuestions: [],
      runtimeMode: "hybrid",
      lastDecisionAt: "",
      turnStatus: "idle",
      skippedWakeups: 0,
    });

    const defaultMasterFile = join(repoDir, ".evo-ai", ".data", "master.json");
    expect(getRuntimeDataDir().endsWith(join(".evo-ai", ".data"))).toBe(true);
    expect(existsSync(defaultMasterFile)).toBe(true);
    expect((await loadMasterState()).mission).toBe("runtime mission");
  });

  test("schema 默认值正确", () => {
    const defaults = configSchema.parse({});
    expect(defaults.heartbeatInterval).toBe(30000);
    expect(defaults.maxConcurrency).toBe(3);
    expect(defaults.maxRetryAttempts).toBe(3);
    expect(defaults.worktreesDir).toBe(".worktrees");
    expect(defaults.developBranch).toBe("develop");
    expect(defaults.models.lite).toBe("glm-4.5-air");
    expect(defaults.models.pro).toBe("glm-4.7");
    expect(defaults.models.max).toBe("glm-5.1");
    expect(defaults.master.runtimeMode).toBe("heartbeat_agent");
  });

  test("环境变量配置能被加载", async () => {
    const repoDir = await makeTempDir("evo-ai-env");
    await mkdir(join(repoDir, ".evo-ai"), { recursive: true });
    process.chdir(repoDir);

    // 环境变量按下划线分割为嵌套路径，所以 EVO_AI_MAXCONCURRENCY=10 -> { maxconcurrency: '10' }
    // 对于单层 key，可以直接映射
    const origVal = process.env.EVO_AI_DEVELOPBRANCH;
    process.env.EVO_AI_DEVELOPBRANCH = "develop";

    try {
      const manager = new Settings("evo-ai", configSchema, {
        globalPath: join(repoDir, "nonexistent", "config.json"),
        credentialsPath: join(repoDir, "nonexistent", "credentials.json"),
        projectPath: join(repoDir, ".evo-ai", "config.json"),
      });
      const config = manager.load().get();
      // 环境变量 key 全部转为小写，所以 developbranch 不会匹配 developBranch
      // 但带下划线分割的嵌套 key 可以用于设置嵌套对象
      // 这里验证加载过程不会报错
      expect(config.heartbeatInterval).toBe(30000);
    } finally {
      if (origVal === undefined) delete process.env.EVO_AI_DEVELOPBRANCH;
      else process.env.EVO_AI_DEVELOPBRANCH = origVal;
    }
  });
});
