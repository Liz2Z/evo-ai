# TUI Agent Work Logs Display - Feature Specification

## Overview

当用户在 TUI 界面中切换到某个任务时，右侧面板需要展示该任务相关的每个 agent（slave）的工作日志。本规格说明书详细描述了该功能的需求、设计和数据流。

## 1. 右侧面板内容设计

### 1.1 基本信息

当选择一个任务后，右侧面板应显示以下信息：

| 元素 | 描述 | 格式 |
|------|------|------|
| 任务 ID | 任务的唯一标识 | `task-abc123` (最后7位) |
| 任务状态 | 当前执行状态 | 颜色编码文本 |
| 任务类型 | fix/feature/refactor 等 | 普通文本 |
| 任务优先级 | 优先级数字 | 普通文本 |
| 任务描述 | 任务的具体描述 | 截断显示(120字符) |

### 1.2 Agent 列表

显示与当前任务相关的所有 agent：

| 元素 | 描述 | 格式 |
|------|------|------|
| Agent ID | agent 的唯一标识 | 最后7位 |
| Agent 类型 | inspector/worker/reviewer | 文本 |
| Agent 状态 | idle/busy/offline | 颜色编码 |
| 开始时间 | agent 开始处理任务的时间 | HH:MM:SS |
| 当前任务 | 正在处理的任务 ID (如果有) | 最后7位 |

### 1.3 工作日志区域

日志区域包含两个视图模式：

#### 实时日志模式 (默认)
- **显示内容**: 当前活跃 agent 的实时日志输出
- **数据源**: 内存 buffer (SlaveLogger)
- **更新频率**: 实时 (通过 `log:message` 事件)
- **日志条目格式**:
  ```
  [HH:MM:SS] [slave-id] [LEVEL] message
  ```
- **状态指示**: 
  - `LIVE LOGS: slave-abc123 (worker) [live]` - 单个 agent
  - `LIVE LOGS: 3 slaves [live]` - 多个 agent
  - `LIVE LOGS: waiting for active slave [live]` - 等待中

#### 完整日志模式 (按 `l` 键切换)
- **显示内容**: 任务的所有历史日志
- **数据源**: 内存 buffer + 文件持久化
- **排序**: 按时间戳升序
- **限制**: 默认显示最后 200 条

### 1.4 日志级别颜色

| 级别 | 颜色 | 用途 |
|------|------|------|
| info | 白色 | 常规信息 |
| error | 红色 | 错误信息 |
| debug | 灰色 | 调试信息 |

## 2. 日志数据来源

### 2.1 SlaveLogger 内存 Buffer

每个 Slave 实例都有一个 `SlaveLogger`，负责：

1. **内存 Buffer**:
   - 类型: `Map<string, LogEntry[]>`
   - Key: `{taskId}` 或 `{slaveId}`
   - 最大容量: 500 条日志
   - 策略: 环形缓冲区 (FIFO)

2. **文件持久化**:
   - 位置: `data/logs/{taskId}.log`
   - 格式: JSON Lines (每行一个 JSON 对象)
   - 触发条件: 每次日志写入时异步追加

### 2.2 全局日志 Buffer

`SlaveLogger` 同时维护一个全局共享 buffer：

```typescript
// Global log buffer for TUI access
const globalLogBuffer: Map<string, LogEntry[]> = new Map()
```

- 目的: 让 TUI 可以直接访问而不需要 SlaveLogger 实例
- Key: `{taskId}`
- 内容: 所有与该任务相关的日志条目

### 2.3 LogEntry 数据结构

```typescript
interface LogEntry {
  timestamp: string      // ISO 8601 格式
  slaveId: string        // agent 的唯一标识
  taskId?: string        // 关联的任务 ID
  level: 'info' | 'error' | 'debug'  // 日志级别
  message: string        // 日志消息
}
```

### 2.4 事件流

日志通过 EventEmitter 传递给 TUI：

```typescript
interface LogMessageEvent {
  slaveId: string
  taskId: string | undefined
  level: 'info' | 'error' | 'debug'
  message: string
  timestamp: string
}
```

## 3. TUI 组件设计

### 3.1 组件层次结构

```
KanbanBoard
├── StatusBar
├── WorktreeList (左侧)
├── DetailPanel (右侧)
│   ├── 任务摘要
│   ├── Agent 列表
│   ├── 实时日志区
│   └── 完整日志区
└── InputBar
```

### 3.2 DetailPanel 组件

**Props**:
```typescript
interface DetailPanelProps {
  task: Task | null                  // 当前选中的任务
  activeSlaves: SlaveInfo[]          // 与该任务关联的活跃 agent
  logs: LogEntry[]                   // 完整日志（内存+文件）
  liveLogs: LogEntry[]               // 实时日志（仅活跃 agent）
  showLogs: boolean                  // 是否显示完整日志模式
  maxHeight: number                  // 最大显示行数
}
```

**渲染模式**:

1. **无任务选中**: 显示 "Select a task to view details"

2. **摘要模式** (`showLogs = false`):
   - 任务基本信息
   - 关联的 agent 列表
   - 实时日志区域 (如果任务处于活跃状态)
   - 提示: "Press 'l' to view full logs"

3. **完整日志模式** (`showLogs = true`):
   - 任务 ID 和日志总数
   - 所有历史日志 (按时间排序)
   - 按 `ESC` 或 `l` 返回摘要模式

### 3.3 自定义 Hooks

#### useMasterState

负责从存储加载和同步状态：

```typescript
function useMasterState(emitter: EventEmitter | null): {
  tasks: Task[]
  slaves: SlaveInfo[]
  selectedTaskId: string | null
  selectTask: (taskId: string | null) => void
  logs: Map<string, LogEntry[]>      // 全局日志 buffer
  // ... 其他状态
}
```

**职责**:
- 从磁盘加载 tasks/slaves/masterState
- 监听 `projection:updated` 事件刷新数据
- 监听 `log:message` 事件更新全局日志 buffer
- 3 秒轮询作为兜底同步机制

#### useLogStream

负责为特定任务加载和流式更新日志：

```typescript
function useLogStream(
  emitter: EventEmitter | null,
  taskId: string | null,
  slaveIds?: string[]                // 可选：过滤特定 agent
): LogEntry[]
```

**职责**:
- 初始加载: 从内存 buffer + 文件加载历史日志
- 实时更新: 监听 `log:message` 事件追加新日志
- 自动去重: 基于唯一 key (`timestamp|slaveId|taskId|level|message`)
- 限制: 默认保留最后 200 条

**数据合并策略**:
```typescript
function mergeLogEntries(
  sources: LogEntry[][],              // [内存, 文件]
  slaveIds?: string[],                // 可选过滤
  limit: number = 200                 // 结果限制
): LogEntry[]
```

## 4. 数据流设计

### 4.1 日志写入流程

```
Slave.execute() 
  → SlaveLogger.info/error/debug()
    → write() to local buffer (ring buffer, max 500)
      → emit('log:message', LogMessageEvent)
        → addToGlobalBuffer(taskId, entry)
          → TUI useLogStream 收到更新
    → persistToFile() (异步, 非阻塞)
      → append to data/logs/{taskId}.log
```

### 4.2 日志读取流程 (TUI)

**初始加载**:
```
DetailPanel mount
  → useLogStream(taskId, activeSlaveIds)
    → loadTaskLogs(taskId, slaveIds)
      → getGlobalLogBuffer().get(taskId)      // 内存
      → readPersistedTaskLogs(taskId)         // 文件
      → mergeLogEntries([内存, 文件])
      → setEntries(initialLogs)
```

**实时更新**:
```
SlaveLogger.emit('log:message', event)
  → Master.on('log:message')
    → addToGlobalBuffer(event.taskId, entry)
  → useLogStream.on('log:message')
    → appendLogEntry(prev, newEntry)
      → merge + 去重 + 限制
      → setEntries(updatedLogs)
  → DetailPanel re-render
```

### 4.3 任务切换流程

```
用户选择新任务
  → selectTask(newTaskId)
    → selectedTaskId 更新
      → useLogStream(taskId) 重新计算
        → 清空旧日志状态
        → 加载新任务的日志
      → activeTaskSlaves 重新计算
        → useLogStream(taskId, activeSlaveIds) 过滤
      → DetailPanel 重新渲染
```

## 5. 性能考虑

### 5.1 内存管理

- **Ring Buffer**: 每个 SlaveLogger 最多保留 500 条日志
- **去重**: 使用 Map 基于 key 去重，避免重复
- **限制**: useLogStream 默认返回最后 200 条
- **清理**: 任务完成后可选择性清理内存 buffer

### 5.2 文件 I/O

- **异步**: 文件持久化使用 `appendFile` 且不 await
- **非阻塞**: 日志写入失败不影响主流程
- **按需**: 文件读取仅在切换任务时执行一次

### 5.3 渲染优化

- **虚拟化**: 大量日志时应考虑虚拟滚动
- **截断**: 超长消息截断到单行显示
- **节流**: 日志更新已有去重机制，避免过度渲染

## 6. 用户体验

### 6.1 视觉反馈

| 状态 | 指示 |
|------|------|
| 任务活跃中 | `[live]` 标签 + 实时日志滚动 |
| 等待 agent | "Waiting for slave logs..." |
| 无日志 | "No logs yet..." |
| 加载中 | 初始加载时显示历史日志 |

### 6.2 交互快捷键

| 按键 | 功能 |
|------|------|
| `l` | 切换日志视图模式 (摘要 ↔ 完整) |
| `ESC` | 返回摘要模式 |
| 方向键 | 选择任务 (在 WorktreeList 中) |

### 6.3 颜色方案

```typescript
const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  assigned: 'yellow',
  running: 'yellow',
  reviewing: 'cyan',
  approved: 'green',
  completed: 'green',
  failed: 'red',
  rejected: 'red',
}
```

## 7. 测试要点

- ✅ 切换任务时正确加载对应日志
- ✅ 实时日志正确更新
- ✅ 多 agent 日志正确合并和排序
- ✅ 日志级别颜色正确
- ✅ 内存和文件日志正确合并
- ✅ 去重机制工作正常
- ✅ 性能: 大量日志时不卡顿

## 8. 依赖文件

- `/src/tui/components/DetailPanel.tsx` - 右侧面板主组件
- `/src/tui/hooks/useLogStream.ts` - 日志流 hook
- `/src/tui/hooks/useMasterState.ts` - 主状态管理 hook
- `/src/utils/logger.ts` - SlaveLogger 实现
- `/src/types/index.ts` - LogEntry 等类型定义
- `/src/types/events.ts` - LogMessageEvent 定义

## 9. 实现状态

当前代码已实现以下功能：

- ✅ `SlaveLogger` 内存 buffer 和文件持久化
- ✅ 全局日志 buffer (`getGlobalLogBuffer()`)
- ✅ `log:message` 事件流
- ✅ `useLogStream` hook (加载 + 实时更新)
- ✅ `useMasterState` 集成全局日志 buffer
- ✅ `DetailPanel` 组件 (摘要模式 + 完整日志模式)
- ✅ agent 列表显示
- ✅ 实时日志过滤 (按活跃 agent)
- ✅ `l` 键切换日志视图

**待完善** (可选增强):

- 大日志虚拟滚动
- 日志搜索/过滤
- 日志导出功能
- 性能监控和优化

---

*文档版本: 1.0*  
*创建日期: 2026-04-14*  
*作者: AI Agent*
