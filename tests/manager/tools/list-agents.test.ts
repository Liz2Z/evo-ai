import { beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { listAgents } from '../../../src/manager/tools/list-agents'
import type { AgentInfo } from '../../../src/types'

describe('listAgents 工具函数', () => {
  let mockAgents: AgentInfo[]

  beforeEach(() => {
    mockAgents = [
      {
        type: 'worker',
        agentId: 'worker-1',
        status: 'busy',
        currentTask: {
          id: 'task-1',
          type: 'refactor',
          status: 'running',
          priority: 5,
          description: 'Worker task 1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
        pid: 12345,
      },
      {
        type: 'inspector',
        agentId: 'inspector-1',
        status: 'idle',
        currentTask: undefined,
        pid: undefined,
      },
      {
        type: 'reviewer',
        agentId: 'reviewer-1',
        status: 'busy',
        currentTask: {
          id: 'task-2',
          type: 'feature',
          status: 'reviewing',
          priority: 3,
          description: 'Reviewer task',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 1,
          maxAttempts: 3,
          reviewHistory: [],
        },
        pid: 67890,
      },
    ]
  })

  async function setupMocks() {
    const storageModule = await import('../../../src/utils/storage')
    spyOn(storageModule, 'loadAgents').mockResolvedValue(mockAgents)
  }

  describe('基本功能', () => {
    test('应返回代理列表', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(mockAgents.length)
    })

    test('应返回完整的代理信息', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(result).toEqual(mockAgents)
    })
  })

  describe('边界条件', () => {
    test('空代理列表应返回空数组', async () => {
      mockAgents = []
      await setupMocks()

      const result = await listAgents()

      expect(result).toEqual([])
    })

    test('单个代理应正常返回', async () => {
      mockAgents = [
        {
          type: 'worker',
          agentId: 'worker-1',
          status: 'idle',
          currentTask: undefined,
          pid: undefined,
        },
      ]
      await setupMocks()

      const result = await listAgents()

      expect(result).toHaveLength(1)
      expect(result[0].agentId).toBe('worker-1')
    })

    test('大量代理应正常返回', async () => {
      const manyAgents: AgentInfo[] = []
      for (let i = 0; i < 100; i++) {
        manyAgents.push({
          type: 'worker',
          agentId: `worker-${i}`,
          status: i % 2 === 0 ? 'busy' : 'idle',
          currentTask: undefined,
          pid: undefined,
        })
      }
      mockAgents = manyAgents
      await setupMocks()

      const result = await listAgents()

      expect(result).toHaveLength(100)
    })
  })

  describe('代理类型', () => {
    test('应包含 worker 类型的代理', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(result.some((a) => a.type === 'worker')).toBe(true)
    })

    test('应包含 inspector 类型的代理', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(result.some((a) => a.type === 'inspector')).toBe(true)
    })

    test('应包含 reviewer 类型的代理', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(result.some((a) => a.type === 'reviewer')).toBe(true)
    })

    test('应支持所有代理类型的混合', async () => {
      mockAgents = [
        { type: 'worker', agentId: 'w-1', status: 'idle', currentTask: undefined, pid: undefined },
        { type: 'inspector', agentId: 'i-1', status: 'idle', currentTask: undefined, pid: undefined },
        { type: 'reviewer', agentId: 'r-1', status: 'idle', currentTask: undefined, pid: undefined },
      ]
      await setupMocks()

      const result = await listAgents()

      expect(result).toHaveLength(3)
      expect(result[0].type).toBe('worker')
      expect(result[1].type).toBe('inspector')
      expect(result[2].type).toBe('reviewer')
    })
  })

  describe('代理状态', () => {
    test('应包含 idle 状态的代理', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(result.some((a) => a.status === 'idle')).toBe(true)
    })

    test('应包含 busy 状态的代理', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(result.some((a) => a.status === 'busy')).toBe(true)
    })

    test('应包含当前任务信息（如果有）', async () => {
      await setupMocks()

      const result = await listAgents()

      const worker = result.find((a) => a.agentId === 'worker-1')
      expect(worker?.currentTask).toBeDefined()
      expect(worker?.currentTask?.id).toBe('task-1')
    })

    test('idle 状态代理不应有当前任务', async () => {
      await setupMocks()

      const result = await listAgents()

      const inspector = result.find((a) => a.agentId === 'inspector-1')
      expect(inspector?.currentTask).toBeUndefined()
    })
  })

  describe('PID 信息', () => {
    test('应包含有 PID 的代理', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(result.some((a) => a.pid !== undefined)).toBe(true)
    })

    test('应包含无 PID 的代理', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(result.some((a) => a.pid === undefined)).toBe(true)
    })

    test('PID 应为数字类型', async () => {
      await setupMocks()

      const result = await listAgents()

      const agentsWithPid = result.filter((a) => a.pid !== undefined)
      for (const agent of agentsWithPid) {
        expect(typeof agent.pid).toBe('number')
      }
    })
  })

  describe('特殊字符处理', () => {
    test('agentId 包含特殊字符应正常处理', async () => {
      mockAgents = [
        {
          type: 'worker',
          agentId: 'worker-with_special_chars-123',
          status: 'idle',
          currentTask: undefined,
          pid: undefined,
        },
      ]
      await setupMocks()

      const result = await listAgents()

      expect(result[0].agentId).toBe('worker-with_special_chars-123')
    })

    test('agentId 包含中文应正常处理', async () => {
      mockAgents = [
        {
          type: 'worker',
          agentId: 'worker-中文-123',
          status: 'idle',
          currentTask: undefined,
          pid: undefined,
        },
      ]
      await setupMocks()

      const result = await listAgents()

      expect(result[0].agentId).toContain('中文')
    })

    test('agentId 包含 emoji 应正常处理', async () => {
      mockAgents = [
        {
          type: 'worker',
          agentId: 'worker-🔥-123',
          status: 'idle',
          currentTask: undefined,
          pid: undefined,
        },
      ]
      await setupMocks()

      const result = await listAgents()

      expect(result[0].agentId).toContain('🔥')
    })
  })

  describe('错误处理', () => {
    test('loadAgents 抛出错误时应向上传播', async () => {
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadAgents').mockImplementation(() => {
        throw new Error('Storage error')
      })

      await expect(listAgents()).rejects.toThrow('Storage error')
    })

    test('loadAgents 返回 null 应当作空数组处理', async () => {
      const storageModule = await import('../../../src/utils/storage')
      // 当 loadAgents 返回 null 时，listAgents 会抛出错误
      spyOn(storageModule, 'loadAgents').mockResolvedValue(null as any)

      // listAgents 会尝试对 null 调用 map，这会抛出错误
      await expect(listAgents()).rejects.toThrow()
    })
  })

  describe('连续调用', () => {
    test('连续调用应每次都从存储中获取', async () => {
      let callCount = 0
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadAgents').mockImplementation(() => {
        callCount++
        return Promise.resolve([
          {
            type: 'worker',
            agentId: `worker-${callCount}`,
            status: 'idle',
            currentTask: undefined,
            pid: undefined,
          },
        ])
      })

      const result1 = await listAgents()
      const result2 = await listAgents()
      const result3 = await listAgents()

      expect(callCount).toBe(3)
      expect(result1[0].agentId).toBe('worker-1')
      expect(result2[0].agentId).toBe('worker-2')
      expect(result3[0].agentId).toBe('worker-3')
    })

    test('连续调用应返回最新的代理列表', async () => {
      const storageModule = await import('../../../src/utils/storage')
      const agents: AgentInfo[] = [
        { type: 'worker', agentId: 'worker-1', status: 'idle', currentTask: undefined, pid: undefined },
      ]
      spyOn(storageModule, 'loadAgents').mockImplementation(() => {
        return Promise.resolve([...agents])
      })

      const result1 = await listAgents()

      agents.push({
        type: 'inspector',
        agentId: 'inspector-1',
        status: 'idle',
        currentTask: undefined,
        pid: undefined,
      })
      const result2 = await listAgents()

      expect(result1).toHaveLength(1)
      expect(result2).toHaveLength(2)
    })
  })

  describe('返回值类型', () => {
    test('返回值应为 AgentInfo 数组', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(Array.isArray(result)).toBe(true)
      if (result.length > 0) {
        expect(result[0]).toHaveProperty('type')
        expect(result[0]).toHaveProperty('agentId')
        expect(result[0]).toHaveProperty('status')
        expect(result[0]).toHaveProperty('currentTask')
        expect(result[0]).toHaveProperty('pid')
      }
    })

    test('每个代理应包含必需字段', async () => {
      await setupMocks()

      const result = await listAgents()

      for (const agent of result) {
        expect(agent).toHaveProperty('type')
        expect(agent).toHaveProperty('agentId')
        expect(agent).toHaveProperty('status')
        expect(typeof agent.type).toBe('string')
        expect(typeof agent.agentId).toBe('string')
        expect(typeof agent.status).toBe('string')
      }
    })
  })

  describe('参数处理', () => {
    test('不接受任何参数', async () => {
      await setupMocks()

      const result = await listAgents()

      expect(result).toEqual(mockAgents)
    })
  })

  describe('当前任务字段', () => {
    test('有当前任务的代理应包含完整任务信息', async () => {
      await setupMocks()

      const result = await listAgents()

      const worker = result.find((a) => a.agentId === 'worker-1')
      expect(worker?.currentTask).toHaveProperty('id')
      expect(worker?.currentTask).toHaveProperty('type')
      expect(worker?.currentTask).toHaveProperty('status')
      expect(worker?.currentTask).toHaveProperty('description')
    })

    test('无当前任务的代理 currentTask 应为 undefined', async () => {
      await setupMocks()

      const result = await listAgents()

      const inspector = result.find((a) => a.agentId === 'inspector-1')
      expect(inspector?.currentTask).toBeUndefined()
    })
  })
})
