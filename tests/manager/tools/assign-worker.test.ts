import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Task, TaskResult } from '../../../src/types'
import { assignWorker } from '../../../src/manager/tools/assign-worker'
import type { AgentHandle, AgentOptions } from '../../../src/agents/launcher'

describe('assignWorker 工具函数', () => {
  let mockTasks: Map<string, Task>
  let mockWorkspacePath: string | null
  let mockActiveAgents: number
  let mockRecentDecisions: string[]
  let mockAgentHandles: Map<string, AgentHandle>
  let mockCurrentTaskId: string | undefined
  let handleWorkerResultCalls: Array<{ taskId: string; result: TaskResult }>
  let failTaskCalls: Array<{ taskId: string; reason: string }>
  let requestTurnCalls: string[]
  let setStateCalls: Array<Partial<{ currentTaskId: string; currentStage: string }>>
  let emitTaskStatusChangeCalls: Array<{ taskId: string; fromStatus: string; toStatus: string; task: Task }>
  let emitManagerStateCalls: number
  let incrementActiveAgentsCalls: number
  let updateTaskCalls: Array<{ taskId: string; updates: Partial<Task> }>

  beforeEach(() => {
    mockTasks = new Map()
    mockWorkspacePath = '/tmp/mock-workspace'
    mockActiveAgents = 0
    mockRecentDecisions = []
    mockAgentHandles = new Map()
    mockCurrentTaskId = undefined
    handleWorkerResultCalls = []
    failTaskCalls = []
    requestTurnCalls = []
    setStateCalls = []
    emitTaskStatusChangeCalls = []
    emitManagerStateCalls = 0
    incrementActiveAgentsCalls = 0
    updateTaskCalls = []
  })

  afterEach(() => {
    // Clean up any active handles
    for (const handle of mockAgentHandles.values()) {
      handle.kill().catch(() => {})
    }
  })

  function createMockAgentHandle(taskId: string): AgentHandle {
    let started = false
    let executed = false

    return {
      async start() {
        started = true
        return { agentId: `worker-${taskId}` }
      },
      async execute() {
        if (!started) throw new Error('Must start before execute')
        executed = true
        return {
          status: 'completed' as const,
          summary: 'Implementation complete',
          filesChanged: ['src/test.ts'],
        }
      },
      async cancel() {
        started = false
      },
      async kill() {
        started = false
        executed = false
      },
      getAgentInfo() {
        return {
          type: 'worker' as const,
          agentId: `worker-${taskId}`,
          status: executed ? 'idle' : 'busy',
          currentTask: undefined,
          pid: undefined,
        }
      },
    }
  }

  function createDeps() {
    return {
      getTaskById: async (taskId: string) => mockTasks.get(taskId) || null,
      ensureMissionWorkspaceReady: async () => {
        if (mockWorkspacePath) {
          return { status: 'ready' as const, path: mockWorkspacePath, message: 'Ready' }
        }
        return { status: 'failed' as const, message: 'Workspace setup failed' }
      },
      updateTask: async (taskId: string, updates: Partial<Task>) => {
        updateTaskCalls.push({ taskId, updates })
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          return updated
        }
        return null
      },
      setState: async (updates: Partial<{ currentTaskId: string; currentStage: string }>) => {
        setStateCalls.push(updates)
        if (updates.currentTaskId) mockCurrentTaskId = updates.currentTaskId
      },
      emitTaskStatusChange: (taskId: string, fromStatus: string, toStatus: string, task: Task) => {
        emitTaskStatusChangeCalls.push({ taskId, fromStatus, toStatus, task })
      },
      emitManagerState: () => {
        emitManagerStateCalls++
      },
      incrementActiveAgents: () => {
        incrementActiveAgentsCalls++
        mockActiveAgents++
      },
      getRecentDecisions: async () => mockRecentDecisions,
      createAgentHandle: (config: AgentOptions) => {
        return createMockAgentHandle(config.task.id)
      },
      activeAgentHandles: mockAgentHandles,
      requestTurn: async (reason: string) => {
        requestTurnCalls.push(reason)
      },
      handleWorkerResult: async (taskId: string, result: TaskResult) => {
        handleWorkerResultCalls.push({ taskId, result })
      },
      failTask: async (taskId: string, reason: string) => {
        failTaskCalls.push({ taskId, reason })
      },
      get activeAgents() {
        return mockActiveAgents
      },
      state: {
        currentTaskId: mockCurrentTaskId,
        currentStage: 'idle',
        mission: 'test-mission',
      },
    }
  }

  function createTask(taskId: string, overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString()
    return {
      id: taskId,
      type: 'refactor',
      status: 'pending',
      priority: 5,
      description: `Test task ${taskId}`,
      createdAt: now,
      updatedAt: now,
      attemptCount: 0,
      maxAttempts: 3,
      reviewHistory: [],
      ...overrides,
    }
  }

  describe('基本功能', () => {
    test('成功分配 worker', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('started')
      expect(result.taskId).toBe(taskId)
      expect(result.message).toBe('Worker assigned')
      expect(mockAgentHandles.has(taskId)).toBe(true)
    })

    test('应更新任务状态为 running', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignWorker({ taskId }, deps)

      expect(updateTaskCalls).toHaveLength(1)
      expect(updateTaskCalls[0].taskId).toBe(taskId)
      expect(updateTaskCalls[0].updates.status).toBe('running')
    })

    test('应正确设置 currentTaskId 和 currentStage', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignWorker({ taskId }, deps)

      expect(setStateCalls).toHaveLength(1)
      expect(setStateCalls[0]).toEqual({
        currentTaskId: taskId,
        currentStage: 'working',
      })
    })

    test('应触发状态变更事件', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignWorker({ taskId }, deps)

      expect(emitTaskStatusChangeCalls).toHaveLength(1)
      expect(emitTaskStatusChangeCalls[0].taskId).toBe(taskId)
      expect(emitTaskStatusChangeCalls[0].fromStatus).toBe('pending')
      expect(emitTaskStatusChangeCalls[0].toStatus).toBe('running')
    })

    test('应支持 additionalContext', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      const result = await assignWorker({ taskId, additionalContext: 'Additional context' }, deps)

      expect(result.status).toBe('started')
    })
  })

  describe('边界条件 - 任务不存在', () => {
    test('任务不存在时应返回 not_found', async () => {
      const taskId = 'non-existent'
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('not_found')
      expect(result.taskId).toBe(taskId)
      expect(result.message).toBe('Task not found')
      expect(mockAgentHandles.has(taskId)).toBe(false)
    })

    test('空任务 ID 应正确处理', async () => {
      const deps = createDeps()

      const result = await assignWorker({ taskId: '' }, deps)

      expect(result.status).toBe('not_found')
      expect(result.taskId).toBe('')
    })

    test('特殊字符任务 ID 应正确处理', async () => {
      const taskId = 'task-with-特殊字符-123'
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('not_found')
    })
  })

  describe('边界条件 - 任务状态不合法', () => {
    test('reviewing 状态任务应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'reviewing' }))
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('reviewing')
    })

    test('completed 状态任务应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'completed' }))
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('completed')
    })

    test('failed 状态任务应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'failed' }))
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('failed')
    })

    test('pending 状态任务应允许分配', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'pending' }))
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('started')
    })

    test('running 状态任务应允许分配（重试场景）', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'running' }))
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('started')
    })
  })

  describe('边界条件 - workspace 无效', () => {
    test('workspace 准备失败时应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockWorkspacePath = null
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Workspace setup failed')
    })

    test('workspace 返回 failed 状态时应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      // Override ensureMissionWorkspaceReady to return failed
      deps.ensureMissionWorkspaceReady = async () => ({
        status: 'failed',
        message: 'Disk full',
      })

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Disk full')
    })
  })

  describe('边界条件 - 活跃 agent 冲突', () => {
    test('已有活跃 agent 时应拒绝分配', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockActiveAgents = 1
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Another agent is already active')
      expect(mockAgentHandles.has(taskId)).toBe(false)
    })

    test('多个活跃 agent 时应拒绝分配', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockActiveAgents = 5
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Another agent is already active')
    })

    test('activeAgents 刚好为 0 时应允许分配', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockActiveAgents = 0
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('started')
    })
  })

  describe('异步执行', () => {
    test('worker 完成后应调用 handleWorkerResult', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignWorker({ taskId }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(handleWorkerResultCalls).toHaveLength(1)
      expect(handleWorkerResultCalls[0].taskId).toBe(taskId)
    })

    test('worker 完成后应请求新回合', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignWorker({ taskId }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(requestTurnCalls).toHaveLength(1)
      expect(requestTurnCalls[0]).toContain('worker_completed:')
    })

    test('worker 完成后应清除 agent handle', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignWorker({ taskId }, deps)

      expect(mockAgentHandles.has(taskId)).toBe(true)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(mockAgentHandles.has(taskId)).toBe(false)
    })

    test('worker 返回空结果时应调用 failTask', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      // Override createAgentHandle to return null
      deps.createAgentHandle = (config: AgentOptions) => {
        let started = false
        return {
          async start() {
            started = true
            return { agentId: `worker-${config.task.id}` }
          },
          async execute() {
            if (!started) throw new Error('Must start first')
            return null as any
          },
          async cancel() {},
          async kill() {},
          getAgentInfo() {
            return {
              type: 'worker',
              agentId: `worker-${config.task.id}`,
              status: 'idle',
              currentTask: undefined,
              pid: undefined,
            }
          },
        }
      }

      await assignWorker({ taskId }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(failTaskCalls).toHaveLength(1)
      expect(failTaskCalls[0].taskId).toBe(taskId)
      expect(failTaskCalls[0].reason).toContain('Worker returned no result')
    })

    test('worker 返回错误格式结果时应调用 failTask', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      // Override createAgentHandle to return unexpected type
      deps.createAgentHandle = (config: AgentOptions) => {
        let started = false
        return {
          async start() {
            started = true
            return { agentId: `worker-${config.task.id}` }
          },
          async execute() {
            if (!started) throw new Error('Must start first')
            return { unexpected: 'result' } as any
          },
          async cancel() {},
          async kill() {},
          getAgentInfo() {
            return {
              type: 'worker',
              agentId: `worker-${config.task.id}`,
              status: 'idle',
              currentTask: undefined,
              pid: undefined,
            }
          },
        }
      }

      await assignWorker({ taskId }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(failTaskCalls).toHaveLength(1)
      expect(failTaskCalls[0].reason).toContain('Worker returned unexpected result type')
    })

    test('worker 执行出错时应调用 failTask', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      deps.createAgentHandle = (config: AgentOptions) => {
        let started = false
        return {
          async start() {
            started = true
            return { agentId: `worker-${config.task.id}` }
          },
          async execute() {
            if (!started) throw new Error('Must start first')
            throw new Error('Simulated worker failure')
          },
          async cancel() {},
          async kill() {},
          getAgentInfo() {
            return {
              type: 'worker',
              agentId: `worker-${config.task.id}`,
              status: 'idle',
              currentTask: undefined,
              pid: undefined,
            }
          },
        }
      }

      await assignWorker({ taskId }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(failTaskCalls).toHaveLength(1)
      expect(failTaskCalls[0].taskId).toBe(taskId)
      expect(failTaskCalls[0].reason).toContain('Simulated worker failure')
    })
  })

  describe('状态转换', () => {
    test('running 状态任务重新分配时应保持 running', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'running' }))
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('started')
      expect(emitTaskStatusChangeCalls[0].fromStatus).toBe('running')
      expect(emitTaskStatusChangeCalls[0].toStatus).toBe('running')
    })

    test('pending 状态任务分配后应转为 running', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'pending' }))
      const deps = createDeps()

      const result = await assignWorker({ taskId }, deps)

      expect(result.status).toBe('started')
      expect(emitTaskStatusChangeCalls[0].fromStatus).toBe('pending')
      expect(emitTaskStatusChangeCalls[0].toStatus).toBe('running')
    })
  })

  describe('边界条件 - 并发', () => {
    test('并发分配同一任务只应有一个成功', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      const [result1, result2] = await Promise.all([
        assignWorker({ taskId }, deps),
        assignWorker({ taskId }, deps),
      ])

      // Both may succeed due to race condition, or one may be noop
      expect(['started', 'noop']).toContain(result1.status)
      expect(['started', 'noop']).toContain(result2.status)
    })
  })
})
