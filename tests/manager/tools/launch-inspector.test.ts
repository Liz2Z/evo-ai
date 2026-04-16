import { beforeEach, describe, expect, test } from 'bun:test'
import type { Task, HistoryEntry } from '../../../src/types'
import { launchInspector } from '../../../src/manager/tools/launch-inspector'
import type { AgentHandle, AgentOptions } from '../../../src/agents/launcher'
import type { SanitizedInspectorTasks } from '../../../src/manager/task-sanitizer'

describe('launchInspector 工具函数', () => {
  let mockActiveAgents: number
  let mockCurrentTaskId: string | undefined
  let mockTasks: Task[]
  let mockRecentDecisions: string[]
  let mockAgentHandles: Map<string, AgentHandle>
  let addHistoryEntries: Array<Omit<HistoryEntry, 'taskId' | 'agentId'> & { taskId?: string; agentId?: string }>
  let addTaskCalls: Task[]
  let requestTurnCalls: string[]
  let setStateCalls: Array<Partial<{ currentStage: string; lastInspection?: string }>>
  let emitManagerStateCalls: number
  let incrementActiveAgentsCalls: number
  let loggerCalls: Array<{ type: 'info' | 'error'; message: string }>

  beforeEach(() => {
    mockActiveAgents = 0
    mockCurrentTaskId = undefined
    mockTasks = []
    mockRecentDecisions = []
    mockAgentHandles = new Map()
    addHistoryEntries = []
    addTaskCalls = []
    requestTurnCalls = []
    setStateCalls = []
    emitManagerStateCalls = 0
    incrementActiveAgentsCalls = 0
    loggerCalls = []
  })

  function createMockAgentHandle(): AgentHandle {
    let started = false
    let executed = false

    return {
      async start() {
        started = true
        return { agentId: 'inspector-1' }
      },
      async execute() {
        if (!started) throw new Error('Must start before execute')
        executed = true
        return {
          summary: JSON.stringify({
            tasks: [
              {
                id: 'task-new-1',
                type: 'refactor',
                status: 'pending',
                priority: 5,
                description: '新发现的任务',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                attemptCount: 0,
                maxAttempts: 3,
                reviewHistory: [],
              },
            ],
          }),
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
          type: 'inspector',
          agentId: 'inspector-1',
          status: executed ? 'idle' : 'busy',
          currentTask: undefined,
          pid: undefined,
        }
      },
    }
  }

  function createDeps() {
    return {
      refreshActiveAgents: async () => {
        // Mock refresh - do nothing
      },
      get activeAgents() {
        return mockActiveAgents
      },
      get currentTaskId() {
        return mockCurrentTaskId
      },
      loadTasks: async () => mockTasks,
      setState: async (updates: Partial<{ currentStage: string; lastInspection?: string }>) => {
        setStateCalls.push(updates)
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
        return createMockAgentHandle()
      },
      activeAgentHandles: mockAgentHandles,
      addHistoryEntry: async (entry: Omit<HistoryEntry, 'taskId' | 'agentId'> & { taskId?: string; agentId?: string }) => {
        addHistoryEntries.push(entry)
      },
      sanitizeInspectorTasks: (rawTasks: Task[], existingTasks: Task[]): SanitizedInspectorTasks => {
        return {
          accepted: rawTasks.filter((t) => !existingTasks.some((e) => e.description === t.description)),
          dropped: rawTasks
            .filter((t) => existingTasks.some((e) => e.description === t.description))
            .map((t) => ({ task: t, reason: 'duplicate' })),
        }
      },
      parseInspectorTasksFromResult: (summary: string, _mission: string): Task[] => {
        const parsed = JSON.parse(summary)
        return parsed.tasks || []
      },
      addTask: async (task: Task) => {
        addTaskCalls.push(task)
      },
      requestTurn: async (reason: string) => {
        requestTurnCalls.push(reason)
      },
      logger: {
        info: (message: string) => loggerCalls.push({ type: 'info', message }),
        error: (message: string) => loggerCalls.push({ type: 'error', message }),
      },
      state: {
        mission: 'test-mission',
        currentStage: 'idle',
      },
    }
  }

  describe('基本功能', () => {
    test('在空闲状态下成功启动 inspector', async () => {
      const deps = createDeps()

      const result = await launchInspector({ reason: 'test_trigger' }, deps)

      expect(result.status).toBe('started')
      expect(result.message).toContain('Inspector launched')
      expect(result.message).toContain('test_trigger')
      expect(result.createdTaskIds).toEqual([])
      expect(setStateCalls[0]).toEqual({ currentStage: 'inspecting' })
      expect(emitManagerStateCalls).toBe(1)
      expect(incrementActiveAgentsCalls).toBe(1)
    })

    test('应使用 "inspection" 作为 handle key', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      expect(mockAgentHandles.has('inspection')).toBe(true)
    })
  })

  describe('边界条件 - 活跃 agent 冲突', () => {
    test('已有活跃 agent 时应返回 noop', async () => {
      mockActiveAgents = 1
      const deps = createDeps()

      const result = await launchInspector({ reason: 'test' }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Mission queue is not idle')
      expect(result.createdTaskIds).toEqual([])
      expect(mockAgentHandles.has('inspection')).toBe(false)
    })

    test('有 currentTaskId 时应返回 noop', async () => {
      mockCurrentTaskId = 'task-1'
      const deps = createDeps()

      const result = await launchInspector({ reason: 'test' }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Mission queue is not idle')
    })

    test('有 pending 任务时应返回 noop', async () => {
      mockTasks = [
        {
          id: 'task-1',
          type: 'other',
          status: 'pending',
          priority: 5,
          description: '待处理任务',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      const deps = createDeps()

      const result = await launchInspector({ reason: 'test' }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Mission queue is not idle')
    })

    test('有 running 任务时应返回 noop', async () => {
      mockTasks = [
        {
          id: 'task-1',
          type: 'other',
          status: 'running',
          priority: 5,
          description: '运行中任务',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      const deps = createDeps()

      const result = await launchInspector({ reason: 'test' }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Mission queue is not idle')
    })

    test('有 reviewing 任务时应返回 noop', async () => {
      mockTasks = [
        {
          id: 'task-1',
          type: 'other',
          status: 'reviewing',
          priority: 5,
          description: '审核中任务',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      const deps = createDeps()

      const result = await launchInspector({ reason: 'test' }, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('Mission queue is not idle')
    })

    test('只有 completed/failed 任务时应允许启动', async () => {
      mockTasks = [
        {
          id: 'task-1',
          type: 'other',
          status: 'completed',
          priority: 5,
          description: '已完成任务',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 1,
          maxAttempts: 3,
          reviewHistory: [],
        },
        {
          id: 'task-2',
          type: 'other',
          status: 'failed',
          priority: 5,
          description: '失败任务',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 3,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      const deps = createDeps()

      const result = await launchInspector({ reason: 'test' }, deps)

      expect(result.status).toBe('started')
    })
  })

  describe('异步执行', () => {
    test('inspector 完成后应添加新任务', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      // Wait for async execution
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(addTaskCalls.length).toBeGreaterThan(0)
    })

    test('inspector 完成后应记录历史', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(addHistoryEntries.length).toBeGreaterThan(0)
    })

    test('inspector 完成后应更新状态为 idle', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      const lastCall = setStateCalls[setStateCalls.length - 1]
      expect(lastCall).toHaveProperty('currentStage', 'idle')
    })

    test('inspector 完成后应设置 lastInspection', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      const lastCall = setStateCalls[setStateCalls.length - 1]
      expect(lastCall?.lastInspection).toBeDefined()
    })

    test('inspector 完成后应请求新回合', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(requestTurnCalls.length).toBeGreaterThan(0)
      expect(requestTurnCalls[0]).toContain('inspector_completed:')
    })

    test('inspector 完成后应清除 agent handle', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      expect(mockAgentHandles.has('inspection')).toBe(true)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(mockAgentHandles.has('inspection')).toBe(false)
    })
  })

  describe('任务去重', () => {
    test('应过滤重复的任务', async () => {
      mockTasks = [
        {
          id: 'task-1',
          type: 'other',
          status: 'pending',
          priority: 5,
          description: '新发现的任务',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(addTaskCalls.length).toBe(0)
    })

    test('应记录被丢弃的任务', async () => {
      mockTasks = [
        {
          id: 'task-1',
          type: 'other',
          status: 'pending',
          priority: 5,
          description: '重复任务',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(loggerCalls.some((c) => c.type === 'info' && c.message.includes('Dropped inspector task'))).toBe(
        true,
      )
    })
  })

  describe('错误处理', () => {
    test('inspector 执行失败应记录错误', async () => {
      const deps = createDeps()
      
      deps.createAgentHandle = () => {
        let started = false
        return {
          async start() {
            started = true
            return { agentId: 'inspector-1' }
          },
          async execute() {
            if (!started) throw new Error('Must start first')
            throw new Error('Inspector failed')
          },
          async cancel() {},
          async kill() {},
          getAgentInfo() {
            return {
              type: 'inspector',
              agentId: 'inspector-1',
              status: 'idle',
              currentTask: undefined,
              pid: undefined,
            }
          },
        }
      }

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(addHistoryEntries.some((e) => e.type === 'error')).toBe(true)
    })

    test('inspector 执行失败应恢复 idle 状态', async () => {
      const deps = createDeps()
      
      deps.createAgentHandle = () => {
        let started = false
        return {
          async start() {
            started = true
            return { agentId: 'inspector-1' }
          },
          async execute() {
            if (!started) throw new Error('Must start first')
            throw new Error('Inspector failed')
          },
          async cancel() {},
          async kill() {},
          getAgentInfo() {
            return {
              type: 'inspector',
              agentId: 'inspector-1',
              status: 'idle',
              currentTask: undefined,
              pid: undefined,
            }
          },
        }
      }

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      const lastCall = setStateCalls[setStateCalls.length - 1]
      expect(lastCall?.currentStage).toBe('idle')
    })

    test('inspector 返回空结果应正常处理', async () => {
      const deps = createDeps()
      
      deps.createAgentHandle = () => {
        let started = false
        return {
          async start() {
            started = true
            return { agentId: 'inspector-1' }
          },
          async execute() {
            if (!started) throw new Error('Must start first')
            return { summary: JSON.stringify({ tasks: [] }) }
          },
          async cancel() {},
          async kill() {},
          getAgentInfo() {
            return {
              type: 'inspector',
              agentId: 'inspector-1',
              status: 'idle',
              currentTask: undefined,
              pid: undefined,
            }
          },
        }
      }

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(addTaskCalls.length).toBe(0)
    })
  })

  describe('reason 参数', () => {
    test('应包含 reason 在返回消息中', async () => {
      const deps = createDeps()

      const result = await launchInspector({ reason: 'manual_trigger' }, deps)

      expect(result.message).toContain('manual_trigger')
    })

    test('应在请求回合时包含 reason', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test_reason' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(requestTurnCalls[0]).toContain('test_reason')
    })
  })

  describe('连续调用', () => {
    test('连续调用应在第一次执行完成后才能执行第二次', async () => {
      const deps = createDeps()

      const result1 = await launchInspector({ reason: 'first' }, deps)
      
      // Second call should fail because inspector is running
      const result2 = await launchInspector({ reason: 'second' }, deps)

      expect(result1.status).toBe('started')
      expect(result2.status).toBe('noop')
    })
  })

  describe('状态转换', () => {
    test('启动时应设置 currentStage 为 inspecting', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      expect(setStateCalls[0]).toEqual({ currentStage: 'inspecting' })
    })

    test('完成时应恢复 currentStage 为 idle', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      const lastCall = setStateCalls[setStateCalls.length - 1]
      expect(lastCall?.currentStage).toBe('idle')
    })
  })

  describe('任务创建', () => {
    test('应正确添加新任务', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(addTaskCalls.length).toBeGreaterThan(0)
      expect(addTaskCalls[0]).toHaveProperty('id')
      expect(addTaskCalls[0]).toHaveProperty('description')
    })

    test('应为每个新任务记录历史', async () => {
      const deps = createDeps()

      await launchInspector({ reason: 'test' }, deps)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(addHistoryEntries.filter((e) => e.type === 'task_created').length).toBeGreaterThan(0)
    })
  })
})
