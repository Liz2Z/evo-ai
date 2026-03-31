# Evo-AI 需求规格文档

## 1. 项目概述

**evo-ai** 是一个 AI 监督系统，由一个 Master AI 监督多个 Slave AI 协同工作。Master 通过心跳机制触发，主动发现并分配任务给不同类型的 Slave 执行。

### 1.1 核心理念

- **AI 监督 AI**：Master 负责调度决策，Slave 负责执行具体任务
- **主动产生任务**：Master 不是被动等待外部任务，而是主动发现需要改进的地方
- **用完即走**：Slave 实例临时创建，任务完成后销毁，上下文通过 prompt 传递

## 2. 系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Master (调度 + 决策)                      │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  心跳调度   │  │  任务队列   │  │  状态管理   │              │
│  │ (setTimeout)│  │ (tasks.json)│  │ (JSON files)│              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                 │
│  ┌─────────────────────────────────────────────────┐            │
│  │              AI 决策层 (Claude Agent SDK)        │            │
│  │  - 产生任务策略  - Review 结果判断  - 人类确认    │            │
│  └─────────────────────────────────────────────────┘            │
└───────────────────────────┬─────────────────────────────────────┘
                            │ 调用 Claude Agent SDK
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │  Inspector   │ │    Worker    │ │   Reviewer   │
     │    Slave     │ │    Slave     │ │    Slave     │
     │              │ │              │ │              │
     │ 发现问题     │ │ 执行任务     │ │ 审查代码     │
     │ 生成任务     │ │              │ │ 代码质量     │
     │              │ │              │ │              │
     │ worktree:    │ │ worktree:    │ │ worktree:    │
     │ 主目录(只读) │ │ .wt/task-xx/ │ │ .wt/task-xx/ │
     └──────────────┘ └──────────────┘ └──────────────┘
```

### 2.2 技术栈

| 组件 | 技术方案 |
|------|----------|
| 运行时 | Bun + TypeScript |
| Master | 代码调度 + AI 决策（混合模式） |
| Slave | Claude Agent SDK |
| 存储 | JSON 文件 |
| 心跳 | setTimeout 链 |

## 3. Master 设计

### 3.1 心跳机制

- **实现方式**：setTimeout 链，等待上一个 tick 完成后开始下一个心跳倒计时
- **默认间隔**：30 秒（可配置）
- **优点**：不会重叠执行，tick 执行时间 + interval = 实际心跳间隔

```typescript
class Master {
  private interval = 30000;

  start() {
    this.tick();
  }

  private async tick() {
    try {
      await this.checkTasks();
      await this.assignTasks();
      await this.reviewResults();
      await this.generateNewTasks();
    } finally {
      setTimeout(() => this.tick(), this.interval);
    }
  }
}
```

### 3.2 Master 目标来源

- **启动时给定**：通过命令行参数或配置文件指定顶层使命
- **自主分解**：Master 将使命分解为具体任务
- **人类确认**：遇到超出权限的决策时请求人类确认

### 3.3 Master 工具集

```typescript
// 查询类
query_tasks(filter?)    // 查任务队列
query_slave(id?)        // 查 Slave 状态
query_history(range?)   // 查历史

// 操作类
create_task(task)       // 创建任务
assign_task(taskId, slaveId)  // 分配任务
cancel_task(taskId)     // 取消任务

// 通信类
ask_human(question)     // 请求人类确认
```

**重要原则**：Master 不直接执行任务，所有执行通过 Slave 完成。

### 3.4 信息分层

| 类型 | 内容 | 传递方式 |
|------|------|----------|
| 直接给 | 当前使命/目标 | 写入 prompt |
| 直接给 | 最近 N 条历史决策 | 写入 prompt |
| 直接给 | 当前状态摘要 | 写入 prompt |
| 按需查询 | 完整任务队列 | 提供查询能力 |
| 按需查询 | Slave 详细状态 | 提供查询能力 |
| 按需查询 | 历史记录 | 提供查询能力 |

## 4. Slave 设计

### 4.1 Slave 类型

| 类型 | 职责 | 工作目录 |
|------|------|----------|
| Inspector | 扫描项目，发现问题，生成任务 | 主 worktree（只读） |
| Worker | 执行具体任务（写代码、重构等） | 独立 worktree |
| Reviewer | 审查 Worker 的产出 | 独立 worktree（只读） |

### 4.2 Slave 生命周期

```
任务来了 → 启动 Slave 实例 → 传递上下文 → 执行 → 返回结果 → 销毁
```

**上下文传递内容**：
- 主目标（通过 system prompt）
- 历史决策（通过 system prompt）
- 相关任务历史（通过 system prompt）

### 4.3 Slave 类型区分

通过不同的 **system prompt** 区分不同类型的 Slave，所有 Slave 都使用完整工具集。

## 5. 任务系统

### 5.1 任务定义

```typescript
interface Task {
  id: string;           // 任务 ID
  type: TaskType;       // 任务类型
  status: TaskStatus;   // 任务状态
  priority: number;     // 优先级 (1-5)
  description: string;  // 自然语言描述
  context?: string;     // 额外上下文
  createdAt: string;    // 创建时间
  updatedAt: string;    // 更新时间
  assignedTo?: string;  // 分配给哪个 Slave
  worktree?: string;    // worktree 路径
  branch?: string;      // 分支名
  attemptCount: number; // 尝试次数
  maxAttempts: number;  // 最大尝试次数
  reviewHistory: ReviewHistory[]; // 审查历史
}
```

### 5.2 任务生命周期

```
Pending → Assigned → Running → Completed/Failed → Reviewing → Approved/Rejected → Merged
```

- **Pending**: 任务在队列中等待
- **Assigned**: 任务已分配给某个 Slave
- **Running**: Slave 正在执行
- **Completed/Failed**: 执行结束
- **Reviewing**: 正在审查
- **Approved/Rejected**: 审查完成
- **Merged**: 已合并到主分支

### 5.3 任务来源

由 **Inspector Slave** 发现问题并生成任务，而不是 Master 自己扫描。

## 6. Worktree 和分支管理

### 6.1 Worktree 结构

```
.worktrees/
├── task-101-fix-login/
├── task-102-add-tests/
└── task-103-refactor/
```

### 6.2 分支命名规范

```
task/<task-id>-<short-description>
```

例如：`task/101-fix-login`

### 6.3 Review 流程

1. Worker 完成任务后提交 diff
2. Reviewer Slave 审查代码
3. Master 根据审查结果决定：合并 / 要求修改 / 放弃

### 6.4 修改流程

当 Reviewer 要求修改时，由**新 Slave** 接手（因为原 Slave 已销毁）：

```
Slave-A 执行 → 销毁
     ↓
Reviewer 审查 → 需要修改
     ↓
Slave-B（新）接手 → 基于 worktree 继续
     ↓
Reviewer 再审 → ...
```

新 Slave 需要知道：
1. 原任务描述
2. 之前做了什么（git diff）
3. Reviewer 的反馈

## 7. 并发控制

### 7.1 并行策略

- **固定并行数**：最多 N 个 Worker 同时工作（默认 3）
- **资源隔离**：任务间无共享资源

```typescript
class Master {
  private maxConcurrency = 3;
  private activeSlaves = 0;

  async dispatchTasks() {
    const pendingTasks = await this.getPendingTasks();

    for (const task of pendingTasks) {
      if (this.activeSlaves >= this.maxConcurrency) break;
      this.activeSlaves++;
      this.startSlave(task).finally(() => this.activeSlaves--);
    }
  }
}
```

## 8. 失败处理

### 8.1 重试策略

- **固定 3 次**：3 次不过就放弃
- 每次重试由新 Slave 执行

### 8.2 失败后处理

1. 写入 `failed_tasks.json`
2. 自动创建 GitHub issue（如果配置了）
3. 保留 worktree（方便人类查看）

## 9. 人类交互

### 9.1 交互方式

- **命令行**：启动时传参数
- **配置文件**：通过修改配置干预

### 9.2 命令示例

```bash
# 启动
bun run start -m "提升这个项目的代码质量"

# 紧急干预
bun run start --pause           # 暂停
bun run start --resume          # 恢复
bun run start --cancel <taskId> # 取消任务

# 查看状态
bun run start --status          # 显示状态
bun run start --tasks           # 列出任务
bun run start --failed          # 列出失败任务

# 添加任务
bun run start --add "修复登录 bug"

# 回答问题
bun run start --answer q-001 "先做兼容性测试"
```

### 9.3 Master 请求人类确认

当 Master 遇到不确定的事，写入 `questions.json`：

```json
{
  "pending": [
    {
      "id": "q-001",
      "question": "我发现依赖 X 有安全漏洞，但升级可能破坏兼容性，要升级吗？",
      "options": ["升级", "不升级", "先做兼容性测试"],
      "createdAt": "2026-03-24T10:00:00Z"
    }
  ]
}
```

## 10. 数据存储

### 10.1 文件结构

```
data/
├── master.json      # Master 状态
├── tasks.json       # 任务队列
├── slaves.json      # Slave 配置和状态
├── failed_tasks.json # 失败任务
└── history/
    └── 2026-03-24.json # 按日期的历史记录
```

### 10.2 配置文件

```json
{
  "mission": "提升代码质量",
  "heartbeatInterval": 30000,
  "maxConcurrency": 3,
  "maxRetryAttempts": 3,
  "worktreesDir": ".worktrees",
  "developBranch": "develop"
}
```

## 11. 心跳流程

```
启动 Master → 给定使命
     │
     ▼
┌─────────────────────────────────────┐
│            心跳循环                  │
│                                     │
│ 1. 检查 Slave 状态                   │
│ 2. 启动 Inspector（完成一批后）       │
│ 3. 分配任务给 Worker（最多3个并行）   │
│ 4. 处理完成的任务                    │
│ 5. 启动 Reviewer 审查               │
│ 6. 合并通过的任务到 develop          │
│ 7. 处理失败任务（3次重试）           │
│ 8. 需要时请求人类确认                │
│                                     │
│ └─→ setTimeout → 下一次心跳          │
└─────────────────────────────────────┘
```

## 12. Inspector 触发频率

- **完成一批任务后**运行
- 避免重复发现问题
- 任务处理完再扫描，能看到改进效果

## 13. 关键决策总结

| 决策点 | 选择 |
|--------|------|
| 心跳机制 | setTimeout 链，等上一个完成 |
| Master 目标 | 启动时给定 + 自主分解 + 人类确认 |
| Slave 类型 | Inspector / Worker / Reviewer |
| Slave 生命周期 | 用完即走，通过 prompt 传递上下文 |
| 存储 | JSON 文件 |
| Worktree | 每个 Worker 独立 worktree |
| 并发 | 固定 3 个并行 |
| 失败策略 | 3 次重试后通知人类 |
| Inspector 频率 | 完成一批任务后 |
| 人类交互 | 命令行 + 配置文件 |
