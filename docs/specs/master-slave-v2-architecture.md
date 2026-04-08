# Evo-AI Master-Slave v2 架构方案

## 1. 目标

1. Master 只做调度与决策，Slave 只做执行与审查。
2. 数据持久化可恢复：进程重启后能继续运行，不丢任务状态。
3. TUI 实时更新：事件驱动为主，轮询仅做兜底。
4. 状态迁移可审计：每次状态变化有事件记录。

## 2. 总体架构

1. Control Plane（Master）：任务状态机、调度、重试、合并决策、人工干预。
2. Execution Plane（Slave）：Inspector、Worker、Reviewer 三类从节点。
3. State Plane：Event Store（append-only）+ Projection（可读快照）。
4. Interface Plane：CLI/TUI 命令入口与状态展示。

## 3. 数据持久化设计

### 3.1 事件日志（权威数据源）

- 路径：`data/events/YYYY-MM-DD.ndjson`
- 格式：每行一个 JSON 事件，append-only
- 最小字段：
  - `eventId`
  - `timestamp`
  - `type`
  - `entityType`
  - `entityId`
  - `payload`

示例：

```json
{
  "eventId": "evt-1744120000000-ab12cd3",
  "timestamp": "2026-04-08T08:00:00.000Z",
  "type": "task.updated",
  "entityType": "task",
  "entityId": "task-123",
  "payload": {
    "fromStatus": "assigned",
    "toStatus": "running",
    "slaveId": "worker-01"
  }
}
```

### 3.2 投影文件（查询视图）

- `data/tasks.json`
- `data/master.json`
- `data/slaves.json`
- `data/failed_tasks.json`

### 3.3 写入顺序（必须遵守）

1. 先写事件（Event Store）。
2. 再更新投影（Projection）。
3. 最后发内存通知（用于 TUI 实时更新）。

## 4. 任务状态机

### 4.1 主链路

`pending -> assigned -> running -> reviewing -> approved -> completed`

### 4.2 回退链路

`reviewing -> pending`（verdict = request_changes 且 attempt 未超限）

### 4.3 失败链路

`running/reviewing -> failed/rejected -> failed_tasks`

### 4.4 迁移规则

1. 每次迁移校验前置状态。
2. 禁止跨级跳转（例如 `pending -> reviewing`）。
3. 迁移必须伴随事件落盘。

## 5. TUI 通信设计

### 5.1 初始加载

TUI 启动时读取投影文件：

1. `tasks.json`
2. `master.json`
3. `slaves.json`

### 5.2 实时更新

订阅以下内存事件：

1. `projection:updated`
2. `task:status_change`
3. `log:message`

### 5.3 兜底一致性

每 3 秒轮询一次投影，做 reconcile，修复漏事件。

## 6. 主从通信契约

### 6.1 Master -> Slave 命令

1. `assign`
2. `cancel`
3. `pause`
4. `resume`

### 6.2 Slave -> Master 结果

1. `started`
2. `progress`
3. `completed`
4. `failed`
5. `reviewed`

### 6.3 消息公共字段

1. `taskId`
2. `slaveId`
3. `timestamp`
4. `idempotencyKey`

## 7. 故障与恢复

1. Master 重启：先加载投影，再重放当日事件增量。
2. Slave 异常退出：任务回到 `pending` 或标记 `failed`（按重试策略）。
3. Worktree 清理：仅清理“无任务引用”的目录；失败任务现场默认保留。
4. 健康检查：PID 存活 + 心跳时效（按配置间隔动态判断）。

## 8. 落地计划

### 阶段 A（最小可用）

1. 引入 `events/*.ndjson` 事件日志。
2. 统一“事件 -> 投影 -> 通知”写入顺序。
3. TUI 接入 `projection:updated`，保留 3 秒轮询兜底。

### 阶段 B（增强）

1. 引入 `idempotencyKey` 防重复执行。
2. 统一命令通道（替代文件轮询控制）。
3. 增加状态迁移守卫和恢复重放工具。

## 9. 验收标准

1. 任意任务状态变化都能在事件日志中追溯。
2. Master 重启后任务状态不丢失，且可继续调度。
3. TUI 1 秒内反映大部分事件，3 秒内最终一致。
4. 避免“状态已写入但 UI 无变化”与“假成功”问题。

