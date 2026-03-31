# Evo-AI 技术设计文档

## 1. 项目结构

```
evo-ai/
├── src/
│   ├── index.ts              # 命令行入口
│   ├── types/
│   │   └── index.ts          # 类型定义
│   ├── master/
│   │   ├── scheduler.ts      # Master 调度器
│   │   └── decision.ts       # AI 决策引擎
│   ├── slave/
│   │   ├── launcher.ts       # Slave 启动器
│   │   └── prompts/          # Slave prompts
│   │       ├── inspector.md
│   │       ├── worker.md
│   │       └── reviewer.md
│   └── utils/
│       ├── storage.ts        # JSON 存储
│       └── git.ts            # Git worktree 管理
├── data/                     # 数据目录
│   ├── master.json
│   ├── tasks.json
│   ├── slaves.json
│   └── history/
├── .worktrees/               # worktree 目录
├── config.json               # 配置文件
├── package.json
└── tsconfig.json
```

## 2. 核心类型定义

```typescript
// 任务类型
type TaskType = 'fix' | 'feature' | 'refactor' | 'test' | 'docs' | 'other';
type TaskStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' 
                | 'reviewing' | 'approved' | 'rejected';

interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  description: string;
  context?: string;
  createdAt: string;
  updatedAt: string;
  assignedTo?: string;
  worktree?: string;
  branch?: string;
  attemptCount: number;
  maxAttempts: number;
  reviewHistory: ReviewHistory[];
}

// 审查结果
type ReviewVerdict = 'approve' | 'request_changes' | 'reject';

interface ReviewResult {
  taskId: string;
  verdict: ReviewVerdict;
  confidence: number;
  summary: string;
  issues: string[];
  suggestions: string[];
}

// Slave 类型
type SlaveType = 'inspector' | 'worker' | 'reviewer';
type SlaveStatus = 'idle' | 'busy' | 'offline';

interface SlaveInfo {
  id: string;
  type: SlaveType;
  status: SlaveStatus;
  currentTask?: string;
  startedAt?: string;
}

// 任务执行结果
interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed';
  worktree: string;
  branch: string;
  diff: string;
  summary: string;
  filesChanged: string[];
}

// Master 状态
interface MasterState {
  mission: string;
  currentPhase: string;
  lastHeartbeat: string;
  lastInspection: string;
  activeSince: string;
  pendingQuestions: Question[];
}

// 配置
interface Config {
  mission: string;
  heartbeatInterval: number;
  maxConcurrency: number;
  maxRetryAttempts: number;
  worktreesDir: string;
  developBranch: string;
}
```

## 3. Master 调度器实现

```typescript
class Master {
  private config: Config;
  private state: MasterState;
  private activeSlaves: number = 0;
  private isRunning: boolean = false;
  private isPaused: boolean = false;

  async start(): Promise<void> {
    this.isRunning = true;
    await this.loadState();
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (!this.isRunning) return;
    setTimeout(() => {
      this.tick().finally(() => this.scheduleNextTick());
    }, this.config.heartbeatInterval);
  }

  private async tick(): Promise<void> {
    if (this.isPaused) return;

    // 1. 检查 Slave 状态
    await this.checkSlaves();

    // 2. 启动 Inspector（完成一批后）
    if (await this.shouldRunInspector()) {
      await this.runInspection();
    }

    // 3. 分配任务给 Worker
    await this.dispatchWorkers();

    // 4. 处理完成的任务
    await this.processCompletedTasks();

    // 5. 启动 Reviewer 审查
    await this.processReviewResults();

    // 6. 合并通过的任务
    await this.mergeApprovedTasks();

    // 7. 处理失败任务
    await this.handleFailedTasks();

    // 8. 保存状态
    await saveMasterState(this.state);
  }
}
```

## 4. Slave 启动器实现

```typescript
class SlaveLauncher {
  private slaveId: string;
  private type: SlaveType;
  private task: Task;
  private worktreePath: string | null = null;
  private branch: string | null = null;

  async execute(): Promise<TaskResult | ReviewResult | null> {
    // 1. 加载 prompt
    const basePrompt = loadPrompt(this.type);
    const contextPrompt = this.buildContextPrompt();
    const fullSystemPrompt = `${basePrompt}\n\n${contextPrompt}`;

    // 2. 为 Worker 创建 worktree
    if (this.type === 'worker' && this.options.baseBranch) {
      const result = await createWorktree(this.task, this.options.baseBranch);
      if (result) {
        this.worktreePath = result.path;
        this.branch = result.branch;
      }
    }

    // 3. 使用 Claude Agent SDK 执行
    const workingDir = this.worktreePath || process.cwd();
    
    const agent = new CodeAgent({
      systemPrompt: fullSystemPrompt,
      cwd: resolve(workingDir),
    });

    const response = await agent.run(this.buildTaskPrompt());
    const output = this.extractOutput(response);

    // 4. 解析结果
    if (this.type === 'reviewer') {
      return this.parseReviewResult(output);
    } else {
      return await this.parseTaskResult(output);
    }
  }

  private buildContextPrompt(): string {
    const { mission, recentDecisions, additionalContext } = this.options;

    let context = `## Main Mission\n${mission}\n\n`;

    if (recentDecisions.length > 0) {
      context += `## Recent Decisions\n${recentDecisions.map(d => `- ${d}`).join('\n')}\n\n`;
    }

    context += `## Current Task\n**Task ID:** ${this.task.id}\n**Type:** ${this.task.type}\n\n`;
    context += `**Description:**\n${this.task.description}\n\n`;

    if (this.worktreePath) {
      context += `## Working Directory\n${this.worktreePath}\nBranch: ${this.branch}\n\n`;
    }

    return context;
  }
}
```

## 5. Git Worktree 管理

```typescript
// 创建 worktree
async function createWorktree(task: Task, baseBranch: string): Promise<{ path: string; branch: string } | null> {
  const worktreeName = `task-${task.id}`;
  const branchName = `task/${task.id}`;
  const worktreePath = join(process.cwd(), '.worktrees', worktreeName);

  const result = await runGit([
    'worktree', 'add', '-b', branchName,
    worktreePath, baseBranch
  ]);

  if (result.exitCode !== 0) return null;
  return { path: worktreePath, branch: branchName };
}

// 获取 diff
async function getDiff(branch: string, baseBranch: string, cwd?: string): Promise<string> {
  const result = await runGit(['diff', `${baseBranch}...${branch}`], cwd);
  return result.stdout;
}

// 合并分支
async function mergeBranch(branch: string, baseBranch: string): Promise<{ success: boolean; message: string }> {
  await runGit(['checkout', baseBranch]);
  const result = await runGit(['merge', '--no-ff', branch, '-m', `Merge ${branch}`]);
  return { success: result.exitCode === 0, message: result.stdout || result.stderr };
}
```

## 6. 存储层

```typescript
// JSON 文件读写
async function readJSON<T>(filename: string, defaultValue: T): Promise<T> {
  const filepath = join(DATA_DIR, filename);
  try {
    const content = await Bun.file(filepath).text();
    return JSON.parse(content);
  } catch {
    return defaultValue;
  }
}

async function writeJSON<T>(filename: string, data: T): Promise<void> {
  await ensureDir(DATA_DIR);
  const filepath = join(DATA_DIR, filename);
  await Bun.write(filepath, JSON.stringify(data, null, 2));
}

// 任务管理
async function loadTasks(): Promise<Task[]> {
  return readJSON('tasks.json', []);
}

async function updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
  const tasks = await loadTasks();
  const index = tasks.findIndex(t => t.id === taskId);
  if (index === -1) return null;
  tasks[index] = { ...tasks[index], ...updates, updatedAt: new Date().toISOString() };
  await saveTasks(tasks);
  return tasks[index];
}
```

## 7. 命令行接口

```typescript
// 命令行参数解析
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mission: { type: 'string', short: 'm' },
    interval: { type: 'string', short: 'i' },
    concurrency: { type: 'string', short: 'c' },
    status: { type: 'boolean', short: 's' },
    tasks: { type: 'boolean', short: 't' },
    failed: { type: 'boolean', short: 'f' },
    add: { type: 'string', short: 'a' },
    cancel: { type: 'string' },
    pause: { type: 'boolean', short: 'p' },
    resume: { type: 'boolean', short: 'r' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});
```

## 8. Slave Prompts

### 8.1 Inspector Prompt

位于 `src/slave/prompts/inspector.md`，职责：
- 扫描代码库发现问题
- 生成结构化任务列表
- 只读访问主 worktree

### 8.2 Worker Prompt

位于 `src/slave/prompts/worker.md`，职责：
- 执行具体编码任务
- 在独立 worktree 中工作
- 提交变更摘要

### 8.3 Reviewer Prompt

位于 `src/slave/prompts/reviewer.md`，职责：
- 审查代码变更
- 返回结构化审查结果
- 判断是否可以合并

## 9. 环境要求

- **Node.js**: 18+
- **Bun**: 最新版
- **Git**: 2.0+
- **环境变量**: `ANTHROPIC_API_KEY`

## 10. 启动方式

```bash
# 设置 API Key
export ANTHROPIC_API_KEY=your-api-key

# 启动 Master
bun run start -m "提升代码质量"

# 开发模式（自动重载）
bun run dev -m "提升代码质量"
```
