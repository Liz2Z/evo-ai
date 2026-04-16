# Evo-AI

An autonomous AI supervision system where a Manager AI oversees and coordinates multiple Worker agents to work on software development tasks.

## 🌟 Overview

Evo-AI implements a hierarchical multi-agent system with a Manager architecture:

- **Manager AI**: Runs continuously with a heartbeat mechanism, autonomously generates tasks, coordinates worker agents, reviews work, and makes decisions about task completion
- **Worker Agents**: Specialized AI agents that execute specific tasks in isolated git worktrees
  - **Inspector**: Examines codebase and reports findings
  - **Worker**: Implements features, fixes bugs, refactors code
  - **Reviewer**: Reviews pull requests and code changes

The system uses git worktrees for isolated task execution, ensuring parallel work doesn't interfere with the main codebase.

## ✨ Features

- **Autonomous Task Generation**: Manager AI generates its own tasks based on a mission statement
- **Single Mission Mode**: Focused execution on one mission at a time
- **Isolated Workspaces**: Each task runs in its own git worktree for safety
- **Code Review System**: Automatic review of all changes before merging
- **Retry Logic**: Failed tasks are automatically retried with feedback
- **Human-in-the-Loop**: Manager can ask questions when it needs clarification
- **State Persistence**: All state is saved to disk for resilience
- **Task Prioritization**: Tasks are prioritized and scheduled automatically
- **TUI Interface**: Real-time terminal UI for monitoring system state
- **Event-Driven Architecture**: Event log for auditability and recovery

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Manager AI                            │
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
│  Worker Agent │ │  Worker Agent │ │  Worker Agent │
└───────────────┘ └───────────────┘ └───────────────┘
        │                 │                 │
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Git Worktree  │ │ Git Worktree  │ │ Git Worktree  │
└───────────────┘ └───────────────┘ └───────────────┘

        ┌─────────────────────────────────────┐
        │         TUI Interface               │
        │  (Real-time monitoring & control)   │
        └─────────────────────────────────────┘

        ┌─────────────────────────────────────┐
        │    pi-coding-agent SDK              │
        │  (Agent session management)         │
        └─────────────────────────────────────┘
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

### Starting the Manager

```bash
# First start with mission
bun run src/index.ts -m "Improve test coverage to 80%"

# Later starts can resume from manager state
bun run src/index.ts

# Start with custom heartbeat interval (in seconds)
bun run src/index.ts -i 60

# Start in TUI mode
bun run src/index.ts --tui

# Start in development mode (auto-reload on changes)
bun run dev
```

### Monitoring and Management

```bash
# Check manager status
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
| `--mission <text>` | `-m` | Set the manager's mission |
| `--interval <seconds>` | `-i` | Set heartbeat interval (default: 30) |
| `--concurrency <n>` | `-c` | **[DEPRECATED]** Ignored in single mission mode (fixed to 1) |
| `--config <path>` | | Use custom config file |
| `--tui` | | Start with TUI interface |
| `--status` | `-s` | Show manager status |
| `--tasks` | `-t` | List current tasks |
| `--failed` | `-f` | List failed tasks |
| `--add <description>` | `-a` | Add a new task manually |
| `--cancel <taskId>` | | Cancel a task |
| `--answer <questionId> <answer>` | | Answer a pending question |
| `--pause` | `-p` | Pause the manager |
| `--resume` | `-r` | Resume the manager |
| `--help` | `-h` | Show help message |

> **Note**: The `--concurrency` option is deprecated. In single mission mode, concurrency is fixed to 1 for focused execution.

## ⚙️ Configuration

Edit `.evo-ai/config.json` to customize the system. Secrets such as provider tokens can be stored separately in `.evo-ai/credentials.json` using the same JSON structure:

```json
{
  "heartbeatInterval": 30000,
  "maxConcurrency": 1,
  "maxRetryAttempts": 3,
  "worktreesDir": ".worktrees",
  "developBranch": "develop",
  "models": {
    "lite": "glm-4.5-air",
    "inspector": "glm-5.1",
    "worker": "glm-4.7",
    "reviewer": "glm-4.7",
    "manager": "glm-4.7"
  },
  "provider": {
    "apiKey": "",
    "baseUrl": ""
  },
  "manager": {
    "runtimeMode": "heartbeat_agent"
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

- **heartbeatInterval**: How often (in ms) the Manager checks for new actions
- **maxConcurrency**: Maximum number of worker agents running simultaneously (fixed to 1 in single mission mode)
- **maxRetryAttempts**: Maximum times a failed task will be retried
- **worktreesDir**: Directory where git worktrees are created
- **developBranch**: Branch where completed tasks are merged
- **models.lite**: Light model for simple tasks such as git worktree title generation
- **models.inspector**: Model for inspector agent (examines codebase)
- **models.worker**: Model for worker agent (implements features)
- **models.reviewer**: Model for reviewer agent (reviews code changes)
- **models.manager**: Model for manager (decision-making and task coordination)
- **provider.apiKey**: API key used by the pi-coding-agent SDK
- **provider.baseUrl**: Optional API base URL override
- **manager.runtimeMode**: Runtime mode - `heartbeat_agent`, `session_agent`, or `hybrid`

Configuration is resolved with deep merge priority:

- global: `XDG config dir/.evo-ai/config.json`
- global credentials: `XDG config dir/.evo-ai/credentials.json`
- local: `<repo>/.evo-ai/config.json`
- local credentials: `<repo>/.evo-ai/credentials.json`

Runtime state is stored under `<repo>/.evo-ai/.data/`.
`mission` is not part of config. On first start you must pass `--mission`; after that it is restored from manager state.
`.env` is not used.

## 📁 Project Structure

```
evo-ai/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── agent/
│   │   └── pi.ts             # pi-coding-agent SDK integration
│   ├── agents/
│   │   ├── child.ts          # Child agent process handling
│   │   ├── launcher.ts       # Worker agent launcher
│   │   └── prompts/
│   │       ├── inspector.md  # Inspector system prompt
│   │       ├── reviewer.md   # Reviewer system prompt
│   │       └── worker.md     # Worker system prompt
│   ├── config/
│   │   ├── core.ts           # Core configuration handling
│   │   ├── env.ts            # Environment variable handling
│   │   ├── errors.ts         # Configuration errors
│   │   ├── index.ts          # Config module exports
│   │   ├── models.ts         # Model configuration
│   │   └── schemas.ts        # Zod validation schemas
│   ├── manager/
│   │   ├── decision.ts       # Manager decision-making logic
│   │   ├── runtime.ts        # Manager runtime control
│   │   ├── scheduler.ts      # Manager orchestrator
│   │   └── task-sanitizer.ts # Task input sanitization
│   ├── runtime/
│   │   └── paths.ts          # Runtime path utilities
│   ├── tui/
│   │   ├── index.tsx         # TUI entry point
│   │   ├── components/       # TUI React components
│   │   └── hooks/            # TUI React hooks
│   ├── types/
│   │   ├── events.ts         # Event type definitions
│   │   └── index.ts          # TypeScript type definitions
│   └── utils/
│       ├── git.ts            # Git operations
│       ├── logger.ts         # Logging utilities
│       ├── storage.ts        # State persistence
│       ├── task-text.ts      # Task text utilities
│       └── time.ts           # Time utilities
├── docs/
│   └── specs/
│       ├── evo-ai.md         # Project specification
│       ├── master-slave-v2-architecture.md  # Architecture design
│       ├── requirements.md   # Requirements documentation
│       └── technical-design.md  # Technical design
├── tests/
│   ├── e2e/                  # End-to-end tests
│   └── unit/                 # Unit tests
├── .evo-ai/
│   ├── config.json          # Local static config
│   ├── credentials.json     # Local secrets, same schema as config.json
│   └── .data/               # Runtime state (events, projections)
├── .github/                  # GitHub workflows
├── tsconfig.json            # TypeScript config
├── biome.json               # Biome linter and formatter config
└── package.json             # Project metadata
```

## 🔄 Task Lifecycle

1. **Creation**: Manager generates a task based on its mission
2. **Assignment**: Task is assigned to an available worker agent
3. **Execution**: Worker creates a git worktree and implements the task
4. **Submission**: Worker submits changes for review
5. **Review**: Manager (or reviewer worker) evaluates the work
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

### Running Tests

```bash
# Run all tests
bun run test

# Run end-to-end tests
bun run test:e2e

# Run specific test suites
bun run test:worktree
bun run test:slave
bun run test:review
bun run test:integration
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
# Start manager with specific mission
bun run src/index.ts -m "Improve test coverage to 80%"

# Monitor progress with TUI
bun run src/index.ts --tui

# Check status
bun run src/index.ts --status
```

### Example 2: Bug Fix Session

```bash
# Start with bug fix mission
bun run src/index.ts -m "Fix all reported bugs"

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

### Manager not responding
- Check if process is running: `ps aux | grep "bun run"`
- Check status: `bun run src/index.ts --status`
- Review logs for errors

### Tasks stuck in "running" state
- Check worker agent processes
- Review worktree directories
- Cancel stuck tasks: `bun run src/index.ts --cancel <task-id>`

### Git worktree issues
- Clean up worktrees: `git worktree prune`
- Remove worktrees manually from `.worktrees/` directory
- Ensure proper permissions on worktree directories

## 📚 Additional Resources

- [Project Specification](docs/specs/evo-ai.md)
- [Architecture Design](docs/specs/master-slave-v2-architecture.md)
- [Requirements](docs/specs/requirements.md)
- [Technical Design](docs/specs/technical-design.md)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Bun Documentation](https://bun.sh/docs)
- [Git Worktree Documentation](https://git-scm.com/docs/git-worktree)
- [pi-coding-agent SDK](https://github.com/mariozechner/pi-coding-agent)
