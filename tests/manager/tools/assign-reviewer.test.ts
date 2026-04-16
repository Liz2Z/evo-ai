import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ReviewResult, Task } from '../../../src/types'
import { assignReviewer } from '../../../src/manager/tools/assign-reviewer'
import type { AgentHandle, AgentOptions } from '../../../src/agents/launcher'

describe('assignReviewer 工具函数', () => {
  let mockTasks: Map<string, Task>
  let mockWorktreePath: string | null
  let mockActiveAgents: number
  let mockDiff: string
  let mockRecentDecisions: string[]
  let mockAgentHandles: Map<string, AgentHandle>
  let mockCurrentTaskId: string | undefined
  let handleReviewResultCalls: Array<{ taskId: string; result: ReviewResult }>
  let failTaskCalls: Array<{ taskId: string; reason: string }>
  let requestTurnCalls: string[]
  let setStateCalls: Array<Partial<{ currentTaskId: string; currentStage: string }>>
  let emitManagerStateCalls: number
  let incrementActiveAgentsCalls: number

  beforeEach(() => {
    mockTasks = new Map()
    mockWorktreePath = '/tmp/mock-worktree'
    mockActiveAgents = 0
    mockDiff = 'mock diff content'
    mockRecentDecisions = []
    mockAgentHandles = new Map()
    mockCurrentTaskId = undefined
    handleReviewResultCalls = []
    failTaskCalls = []
    requestTurnCalls = []
    setStateCalls = []
    emitManagerStateCalls = 0
    incrementActiveAgentsCalls = 0
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
        return { agentId: `reviewer-${taskId}` }
      },
      async execute() {
        if (!started) throw new Error('Must start before execute')
        executed = true
        return {
          taskId,
          verdict: 'approve' as const,
          confidence: 0.95,
          summary: 'Looks good',
          issues: [],
          suggestions: [],
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
          type: 'reviewer' as const,
          agentId: `reviewer-${taskId}`,
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
      validateMissionWorktree: () => mockWorktreePath,
      setState: async (updates: Partial<{ currentTaskId: string; currentStage: string }>) => {
        setStateCalls.push(updates)
        if (updates.currentTaskId) mockCurrentTaskId = updates.currentTaskId
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
        const handle = createMockAgentHandle(config.task.id)
        return handle
      },
      activeAgentHandles: mockAgentHandles,
      requestTurn: async (reason: string) => {
        requestTurnCalls.push(reason)
      },
      handleReviewResult: async (taskId: string, result: ReviewResult) => {
        handleReviewResultCalls.push({ taskId, result })
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
      status: 'reviewing',
      priority: 5,
      description: `Test task ${taskId}`,
      createdAt: now,
      updatedAt: now,
      attemptCount: 1,
      maxAttempts: 3,
      reviewHistory: [],
      ...overrides,
    }
  }

  describe('基本功能', () => {
    test('成功分配 reviewer', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('started')
      expect(result.taskId).toBe(taskId)
      expect(result.message).toBe('Reviewer assigned')
      expect(mockAgentHandles.has(taskId)).toBe(true)
      expect(incrementActiveAgentsCalls).toBe(1)
      expect(emitManagerStateCalls).toBe(1)
    })

    test('应正确设置 currentTaskId 和 currentStage', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignReviewer({ taskId }, deps)

      expect(setStateCalls).toHaveLength(1)
      expect(setStateCalls[0]).toEqual({
        currentTaskId: taskId,
        currentStage: 'reviewing',
      })
    })
  })

  describe('边界条件 - 任务不存在', () => {
    test('任务不存在时应返回 not_found', async () => {
      const taskId = 'non-existent'
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('not_found')
      expect(result.taskId).toBe(taskId)
      expect(result.message).toBe('Task not found')
      expect(mockAgentHandles.has(taskId)).toBe(false)
    })

    test('空任务 ID 应正确处理', async () => {
      const deps = createDeps()

      const result = await assignReviewer({ taskId: '' }, deps)

      expect(result.status).toBe('not_found')
      expect(result.taskId).toBe('')
    })

    test('特殊字符任务 ID 应正确处理', async () => {
      const taskId = 'task-with-特殊字符-123'
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('not_found')
    })
  })

  describe('边界条件 - 任务状态不合法', () => {
    test('pending 状态任务应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'pending' }))
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('pending')
      expect(mockAgentHandles.has(taskId)).toBe(false)
    })

    test('running 状态任务应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'running' }))
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('running')
    })

    test('completed 状态任务应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'completed' }))
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('completed')
    })

    test('failed 状态任务应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'failed' }))
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('failed')
    })

    test('reviewing 状态任务应允许分配', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId, { status: 'reviewing' }))
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('started')
    })
  })

  describe('边界条件 - workspace 无效', () => {
    test('workspace 缺失时应返回 noop', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockWorktreePath = null
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Mission workspace is missing or invalid')
    })

    test('workspace 空字符串应视为无效', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockWorktreePath = ''
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
    })
  })

  describe('边界条件 - 活跃 agent 冲突', () => {
    test('已有活跃 agent 时应拒绝分配', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockActiveAgents = 1
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Another agent is already active')
      expect(mockAgentHandles.has(taskId)).toBe(false)
    })

    test('多个活跃 agent 时应拒绝分配', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockActiveAgents = 5
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Another agent is already active')
    })

    test('activeAgents 刚好为 0 时应允许分配', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockActiveAgents = 0
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('started')
    })
  })

  describe('边界条件 - 无 diff 可审', () => {
    test('空 diff 应导致任务失败', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockDiff = '   '
      const deps = createDeps()

      // Mock getUncommittedDiff
      const originalModule = await import('../../../src/utils/git')
      const spyGetUncommittedDiff = () => mockDiff

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('No diff to review')
      expect(failTaskCalls).toHaveLength(1)
      expect(failTaskCalls[0]).toEqual({
        taskId,
        reason: 'No diff to review in mission workspace',
      })
    })

    test('完全空字符串 diff 应导致任务失败', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      mockDiff = ''
      const deps = createDeps()

      const result = await assignReviewer({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('No diff to review')
    })
  })

  describe('异步执行', () => {
    test('reviewer 完成后应调用 handleReviewResult', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignReviewer({ taskId }, deps)

      // Wait for async execution
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(handleReviewResultCalls).toHaveLength(1)
      expect(handleReviewResultCalls[0].taskId).toBe(taskId)
    })

    test('reviewer 完成后应请求新回合', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignReviewer({ taskId }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(requestTurnCalls).toHaveLength(1)
      expect(requestTurnCalls[0]).toContain('review_completed:')
    })

    test('reviewer 完成后应清除 agent handle', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      await assignReviewer({ taskId }, deps)

      // Initially should have handle
      expect(mockAgentHandles.has(taskId)).toBe(true)

      await new Promise((resolve) => setTimeout(resolve, 50))

      // After completion should be removed
      expect(mockAgentHandles.has(taskId)).toBe(false)
    })

    test('reviewer 错误时应调用 failTask', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()
      
      // Override createAgentHandle to create a failing handle
      deps.createAgentHandle = (config: AgentOptions) => {
        let started = false
        return {
          async start() {
            started = true
            return { agentId: `reviewer-${config.task.id}` }
          },
          async execute() {
            if (!started) throw new Error('Must start first')
            throw new Error('Simulated reviewer failure')
          },
          async cancel() {},
          async kill() {},
          getAgentInfo() {
            return {
              type: 'reviewer',
              agentId: `reviewer-${config.task.id}`,
              status: 'idle',
              currentTask: undefined,
              pid: undefined,
            }
          },
        }
      }

      await assignReviewer({ taskId }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(failTaskCalls).toHaveLength(1)
      expect(failTaskCalls[0].taskId).toBe(taskId)
      expect(failTaskCalls[0].reason).toContain('Simulated reviewer failure')
    })
  })

  describe('边界条件 - 并发', () => {
    test('连续分配同一任务应成功（如果第一次完成）', async () => {
      const taskId = 'task-1'
      mockTasks.set(taskId, createTask(taskId))
      const deps = createDeps()

      const result1 = await assignReviewer({ taskId }, deps)
      
      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Active agents should be cleared
      mockActiveAgents = 0
      mockAgentHandles.clear(taskId)
      mockCurrentTaskId = undefined

      const result2 = await assignReviewer({ taskId }, deps)

      expect(result1.status).toBe('started')
      expect(result2.status).toBe('started')
    })
  })
})
