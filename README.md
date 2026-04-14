# Evo-AI

An autonomous AI supervision system where a Master AI oversees and coordinates multiple Slave AI agents to work on software development tasks.

## 🌟 Overview

Evo-AI implements a hierarchical multi-agent system with a Master-Slave architecture:

- **Master AI**: Runs continuously with a heartbeat mechanism, autonomously generates tasks, coordinates Slave agents, reviews work, and makes decisions about task completion
- **Slave Agents**: Specialized AI agents that execute specific tasks in isolated git worktrees
  - **Inspector**: Examines codebase and reports findings
  - **Worker**: Implements features, fixes bugs, refactors code
  - **Reviewer**: Reviews pull requests and code changes

The system uses git worktrees for isolated task execution, ensuring parallel work doesn't interfere with the main codebase.

## ✨ Features

- **Autonomous Task Generation**: Master AI generates its own tasks based on a mission statement
- **Parallel Execution**: Multiple slave agents can work concurrently on different tasks
- **Isolated Workspaces**: Each task runs in its own git worktree for safety
- **Code Review System**: Automatic review of all changes before merging
- **Retry Logic**: Failed tasks are automatically retried with feedback
- **Human-in-the-Loop**: Master can ask questions when it needs clarification
- **State Persistence**: All state is saved to disk for resilience
- **Task Prioritization**: Tasks are prioritized and scheduled automatically

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Master AI                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Heartbeat │  │   Decision  │  │   Task      │         │
│  │   Loop      │──│   Making    │──│   Queue     │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ assigns tasks
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│  Inspector    │ │    Worker     │ │   Reviewer    │
│  Slave Agent  │ │  Slave Agent  │ │  Slave Agent  │
└───────────────┘ └───────────────┘ └───────────────┘
        │                 │                 │
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Git Worktree  │ │ Git Worktree  │ │ Git Worktree  │
└───────────────┘ └───────────────┘ └───────────────┘
```

## 🚀 Setup

### Prerequisites

- **Bun** >= 1.0.0
- **Git** (for worktree support)
- **TypeScript** >= 5.0.0

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd evo-ai
```

2. Install dependencies:
```bash
bun install
```

3. Ensure you're in a git repository:
```bash
git init  # if not already initialized
```

4. Configure the system:
```bash
# Edit .evo-ai/config.json
# First start must provide --mission
```

## 📖 Usage

### Starting the Master

```bash
# First start with mission
bun run src/index.ts -m "Improve test coverage to 80%"

# Later starts can resume from master.json
bun run src/index.ts

# Start with custom heartbeat interval (in seconds)
bun run src/index.ts -i 60

# Start with custom concurrency level
bun run src/index.ts -c 5

# Start in development mode (auto-reload on changes)
bun run dev
```

### Monitoring and Management

```bash
# Check master status
bun run src/index.ts --status

# List all tasks
bun run src/index.ts --tasks

# List failed tasks
bun run src/index.ts --failed

# Add a task manually
bun run src/index.ts --add "Fix the login bug"

# Cancel a task
bun run src/index.ts --cancel <task-id>

# Answer a pending question
bun run src/index.ts --answer <question-id> "your answer"
```

### Command-Line Options

| Option | Short | Description |
|--------|-------|-------------|
| `--mission <text>` | `-m` | Set the master's mission |
| `--interval <seconds>` | `-i` | Set heartbeat interval (default: 30) |
| `--concurrency <n>` | `-c` | Set max concurrent slaves (default: 3) |
| `--status` | `-s` | Show master status |
| `--tasks` | `-t` | List current tasks |
| `--failed` | `-f` | List failed tasks |
| `--add <description>` | `-a` | Add a new task manually |
| `--cancel <taskId>` | | Cancel a task |
| `--answer <questionId> <answer>` | | Answer a pending question |
| `--pause` | `-p` | Pause the master |
| `--resume` | `-r` | Resume the master |
| `--help` | `-h` | Show help message |

## ⚙️ Configuration

Edit `.evo-ai/config.json` to customize the system. Secrets such as provider tokens can be stored separately in `.evo-ai/credentials.json` using the same JSON structure:

```json
{
  "heartbeatInterval": 30000,
  "maxConcurrency": 3,
  "maxRetryAttempts": 3,
  "worktreesDir": ".worktrees",
  "developBranch": "main",
  "models": {
    "lite": "haiku",
    "pro": "sonnet",
    "max": "opus"
  },
  "provider": {
    "apiKey": "",
    "baseUrl": ""
  }
}
```

```json
{
  "provider": {
    "apiKey": "your-token"
  }
}
```

### Configuration Options

- **heartbeatInterval**: How often (in ms) the Master checks for new actions
- **maxConcurrency**: Maximum number of slave agents running simultaneously
- **maxRetryAttempts**: Maximum times a failed task will be retried
- **worktreesDir**: Directory where git worktrees are created
- **developBranch**: Branch where completed tasks are merged
- **models.lite**: Light model for simple tasks such as git worktree title generation
- **models.pro**: Default execution model for all slave roles (inspector / worker / reviewer)
- **models.max**: Reserved master model for heavyweight master-side reasoning
- **provider.apiKey**: API key used by the Claude Agent SDK
- **provider.baseUrl**: Optional API base URL override

Configuration is resolved with deep merge priority:

- global: `XDG config dir/.evo-ai/config.json`
- global credentials: `XDG config dir/.evo-ai/credentials.json`
- local: `<repo>/.evo-ai/config.json`
- local credentials: `<repo>/.evo-ai/credentials.json`

Runtime state is stored under `<repo>/.evo-ai/.data/`.
`mission` is not part of config. On first start you must pass `--mission`; after that it is restored from `master.json`.
`.env` is not used.

## 📁 Project Structure

```
evo-ai/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── master/
│   │   ├── scheduler.ts      # Master orchestrator
│   │   └── decision.ts       # Decision-making logic
│   ├── slave/
│   │   ├── launcher.ts       # Slave agent launcher
│   │   └── prompts/
│   │       ├── inspector.md  # Inspector system prompt
│   │       ├── reviewer.md   # Reviewer system prompt
│   │       └── worker.md     # Worker system prompt
│   ├── types/
│   │   └── index.ts          # TypeScript type definitions
│   └── utils/
│       ├── git.ts            # Git operations
│       └── storage.ts        # State persistence
├── docs/
│   └── specs/
│       └── evo-ai.md         # Project specification
├── .evo-ai/
│   ├── config.json          # Local static config
│   ├── credentials.json     # Local secrets, same schema as config.json
│   └── .data/               # Runtime state
├── tsconfig.json            # TypeScript config
└── package.json             # Project metadata
```

## 🔄 Task Lifecycle

1. **Creation**: Master generates a task based on its mission
2. **Assignment**: Task is assigned to an available slave agent
3. **Execution**: Slave creates a git worktree and implements the task
4. **Submission**: Slave submits changes for review
5. **Review**: Master (or reviewer slave) evaluates the work
6. **Decision**:
   - ✅ **Approve**: Changes are merged to develop branch
   - 🔄 **Request Changes**: Task is sent back with feedback
   - ❌ **Reject**: Task is marked as failed
7. **Retry**: If failed and attempts remain, task is reassigned

## 🛠️ Development

### 代码质量检查

本项目使用 [Biome](https://biomejs.dev/) 进行代码检查和格式化。Biome 是一个快速的 JavaScript/TypeScript 代码检查器和格式化工具。

#### 检查代码

运行代码检查（不修改文件）：

```bash
bun run lint
```

#### 自动修复问题

自动修复可修复的代码问题：

```bash
bun run lint:fix
```

#### 格式化代码

格式化所有代码文件：

```bash
bun run format
```

#### 完整检查

运行完整的代码检查和格式化（包括自动修复）：

```bash
bun run check
```

#### Biome 配置

Biome 的配置文件位于 `biome.json`，包含以下规则：

- **Linter（代码检查）**：启用了推荐的规则集，包括：
  - 代码正确性检查（未使用的变量、导入等）
  - 可疑代码检测
  - 代码风格检查
  - 复杂度分析
  - 可访问性检查
  - 性能优化建议
  - 安全性检查

- **Formatter（代码格式化）**：统一代码风格
  - 缩进：2个空格
  - 行宽：100字符
  - 引号：单引号（JSX中使用双引号）
  - 分号：按需添加
  - 尾随逗号：始终添加

#### 集成到开发流程

建议在以下场景运行代码检查：

1. **提交前**：`bun run check` 确保代码质量
2. **PR 前的审查**：`bun run lint` 检查代码问题
3. **日常开发**：使用编辑器的 Biome 插件实时反馈

### Type Checking

```bash
bun run typecheck
```

### Building

```bash
bun run build
```

### Running in Development Mode

```bash
bun run dev
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📝 License

[Specify your license here]

## 🎯 Example Workflows

### Example 1: Improving Test Coverage

```bash
# Start master with specific mission
bun run src/index.ts -m "Improve test coverage to 80%"

# Monitor progress
bun run src/index.ts --tasks

# Check status
bun run src/index.ts --status
```

### Example 2: Bug Fix Marathon

```bash
# Start with higher concurrency
bun run src/index.ts -c 5 -m "Fix all reported bugs"

# Monitor failed tasks
bun run src/index.ts --failed

# Add specific bug manually
bun run src/index.ts --add "Fix login timeout issue"
```

### Example 3: Continuous Maintenance

```bash
# Start with longer heartbeat interval
bun run src/index.ts -i 300 -m "Maintain code quality and fix issues"

# Run in background with process manager
pm2 start "bun run src/index.ts" --name evo-ai
```

## 🔍 Troubleshooting

### Master not responding
- Check if process is running: `ps aux | grep "bun run"`
- Check status: `bun run src/index.ts --status`
- Review logs for errors

### Tasks stuck in "running" state
- Check slave agent processes
- Review worktree directories
- Cancel stuck tasks: `bun run src/index.ts --cancel <task-id>`

### Git worktree issues
- Clean up worktrees: `git worktree prune`
- Remove worktrees manually from `.worktrees/` directory
- Ensure proper permissions on worktree directories

## 📚 Additional Resources

- [Project Specification](docs/specs/evo-ai.md)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Bun Documentation](https://bun.sh/docs)
- [Git Worktree Documentation](https://git-scm.com/docs/git-worktree)
