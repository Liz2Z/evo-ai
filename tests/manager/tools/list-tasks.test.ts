import { beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { listTasks } from '../../../src/manager/tools/list-tasks'
import type { Task } from '../../../src/types'

describe('listTasks 工具函数', () => {
  let mockTasks: Task[]

  beforeEach(() => {
    const now = new Date().toISOString()
    mockTasks = [
      {
        id: 'task-1',
        type: 'refactor',
        status: 'pending',
        priority: 5,
        description: '待处理任务 1',
        createdAt: now,
        updatedAt: now,
        attemptCount: 0,
        maxAttempts: 3,
        reviewHistory: [],
      },
      {
        id: 'task-2',
        type: 'feature',
        status: 'running',
        priority: 3,
        description: '运行中任务',
        createdAt: now,
        updatedAt: now,
        attemptCount: 1,
        maxAttempts: 3,
        reviewHistory: [],
      },
      {
        id: 'task-3',
        type: 'bugfix',
        status: 'completed',
        priority: 7,
        description: '已完成任务',
        createdAt: now,
        updatedAt: now,
        attemptCount: 1,
        maxAttempts: 3,
        reviewHistory: [],
      },
      {
        id: 'task-4',
        type: 'other',
        status: 'failed',
        priority: 2,
        description: '失败任务',
        createdAt: now,
        updatedAt: now,
        attemptCount: 3,
        maxAttempts: 3,
        reviewHistory: [],
      },
      {
        id: 'task-5',
        type: 'test',
        status: 'reviewing',
        priority: 4,
        description: '审核中任务',
        createdAt: now,
        updatedAt: now,
        attemptCount: 1,
        maxAttempts: 3,
        reviewHistory: [],
      },
    ]
  })

  async function setupMocks() {
    const storageModule = await import('../../../src/utils/storage')
    spyOn(storageModule, 'loadTasks').mockResolvedValue(mockTasks)
  }

  describe('基本功能', () => {
    test('应返回所有任务（无过滤）', async () => {
      await setupMocks()

      const result = await listTasks()

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(mockTasks.length)
    })

    test('应返回完整的任务对象', async () => {
      await setupMocks()

      const result = await listTasks()

      expect(result).toEqual(mockTasks)
    })
  })

  describe('状态过滤 - 单个状态', () => {
    test('过滤 pending 状态任务', async () => {
      await setupMocks()

      const result = await listTasks({ status: 'pending' })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('task-1')
      expect(result[0].status).toBe('pending')
    })

    test('过滤 running 状态任务', async () => {
      await setupMocks()

      const result = await listTasks({ status: 'running' })

      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('running')
    })

    test('过滤 completed 状态任务', async () => {
      await setupMocks()

      const result = await listTasks({ status: 'completed' })

      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('completed')
    })

    test('过滤 failed 状态任务', async () => {
      await setupMocks()

      const result = await listTasks({ status: 'failed' })

      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('failed')
    })

    test('过滤 reviewing 状态任务', async () => {
      await setupMocks()

      const result = await listTasks({ status: 'reviewing' })

      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('reviewing')
    })
  })

  describe('状态过滤 - 多个状态', () => {
    test('过滤 pending 和 running 状态任务', async () => {
      await setupMocks()

      const result = await listTasks({ status: ['pending', 'running'] })

      expect(result).toHaveLength(2)
      expect(result.every((t) => t.status === 'pending' || t.status === 'running')).toBe(true)
    })

    test('过滤 completed 和 failed 状态任务', async () => {
      await setupMocks()

      const result = await listTasks({ status: ['completed', 'failed'] })

      expect(result).toHaveLength(2)
      expect(result.every((t) => t.status === 'completed' || t.status === 'failed')).toBe(true)
    })

    test('过滤所有活跃状态任务', async () => {
      await setupMocks()

      const result = await listTasks({ status: ['pending', 'running', 'reviewing'] })

      expect(result).toHaveLength(3)
      expect(result.every((t) => ['pending', 'running', 'reviewing'].includes(t.status))).toBe(
        true,
      )
    })

    test('过滤包含不存在状态应返回空', async () => {
      await setupMocks()

      const result = await listTasks({ status: ['nonexistent'] })

      expect(result).toHaveLength(0)
    })

    test('过滤混合存在和不存在的状态', async () => {
      await setupMocks()

      const result = await listTasks({ status: ['pending', 'nonexistent'] })

      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('pending')
    })
  })

  describe('边界条件', () => {
    test('空任务列表应返回空数组', async () => {
      mockTasks = []
      await setupMocks()

      const result = await listTasks()

      expect(result).toEqual([])
    })

    test('单条任务应正常返回', async () => {
      mockTasks = [
        {
          id: 'task-1',
          type: 'other',
          status: 'pending',
          priority: 5,
          description: '唯一任务',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      await setupMocks()

      const result = await listTasks()

      expect(result).toHaveLength(1)
    })

    test('超长任务列表应正常处理', async () => {
      const longTaskList: Task[] = []
      for (let i = 0; i < 1000; i++) {
        longTaskList.push({
          id: `task-${i}`,
          type: 'other',
          status: i % 2 === 0 ? 'pending' : 'completed',
          priority: 5,
          description: `任务 ${i}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        })
      }
      mockTasks = longTaskList
      await setupMocks()

      const result = await listTasks()

      expect(result).toHaveLength(1000)
    })

    test('过滤结果为空时应返回空数组', async () => {
      await setupMocks()

      const result = await listTasks({ status: 'nonexistent' })

      expect(result).toEqual([])
    })

    test('空状态数组应返回所有任务', async () => {
      await setupMocks()

      // @ts-expect-error - Testing with empty array
      const result = await listTasks({ status: [] })

      expect(result).toHaveLength(mockTasks.length)
    })
  })

  describe('undefined 参数', () => {
    test('undefined 参数应返回所有任务', async () => {
      await setupMocks()

      const result = await listTasks(undefined)

      expect(result).toHaveLength(mockTasks.length)
    })

    test('null 参数应返回所有任务', async () => {
      await setupMocks()

      // @ts-expect-error - Testing with null
      const result = await listTasks(null)

      expect(result).toHaveLength(mockTasks.length)
    })

    test('空对象参数应返回所有任务', async () => {
      await setupMocks()

      const result = await listTasks({})

      expect(result).toHaveLength(mockTasks.length)
    })
  })

  describe('任务类型', () => {
    test('应包含不同类型的任务', async () => {
      await setupMocks()

      const result = await listTasks()

      expect(result.some((t) => t.type === 'refactor')).toBe(true)
      expect(result.some((t) => t.type === 'feature')).toBe(true)
      expect(result.some((t) => t.type === 'bugfix')).toBe(true)
      expect(result.some((t) => t.type === 'other')).toBe(true)
      expect(result.some((t) => t.type === 'test')).toBe(true)
    })

    test('不过滤类型，应返回所有类型', async () => {
      await setupMocks()

      const result = await listTasks({ status: 'pending' })

      expect(result[0].type).toBe('refactor')
    })
  })

  describe('任务字段完整性', () => {
    test('返回的任务应包含所有必需字段', async () => {
      await setupMocks()

      const result = await listTasks()

      for (const task of result) {
        expect(task).toHaveProperty('id')
        expect(task).toHaveProperty('type')
        expect(task).toHaveProperty('status')
        expect(task).toHaveProperty('priority')
        expect(task).toHaveProperty('description')
        expect(task).toHaveProperty('createdAt')
        expect(task).toHaveProperty('updatedAt')
        expect(task).toHaveProperty('attemptCount')
        expect(task).toHaveProperty('maxAttempts')
        expect(task).toHaveProperty('reviewHistory')
      }
    })

    test('返回的任务应保持原始字段值', async () => {
      await setupMocks()

      const result = await listTasks()

      expect(result[0].id).toBe('task-1')
      expect(result[0].priority).toBe(5)
      expect(result[0].attemptCount).toBe(0)
    })
  })

  describe('错误处理', () => {
    test('loadTasks 抛出错误时应向上传播', async () => {
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadTasks').mockImplementation(() => {
        throw new Error('Storage error')
      })

      await expect(listTasks()).rejects.toThrow('Storage error')
    })

    test('loadTasks 返回 null 应当作空数组处理', async () => {
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadTasks').mockResolvedValue(null as any)

      const result = await listTasks()

      expect(result).toEqual([])
    })
  })

  describe('连续调用', () => {
    test('连续调用应每次都从存储中获取', async () => {
      let callCount = 0
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadTasks').mockImplementation(() => {
        callCount++
        return Promise.resolve([
          {
            id: `task-${callCount}`,
            type: 'other',
            status: 'pending',
            priority: 5,
            description: `Task ${callCount}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attemptCount: 0,
            maxAttempts: 3,
            reviewHistory: [],
          },
        ])
      })

      const result1 = await listTasks()
      const result2 = await listTasks()
      const result3 = await listTasks()

      expect(callCount).toBe(3)
      expect(result1[0].id).toBe('task-1')
      expect(result2[0].id).toBe('task-2')
      expect(result3[0].id).toBe('task-3')
    })

    test('连续调用应返回最新的任务列表', async () => {
      const storageModule = await import('../../../src/utils/storage')
      let tasks: Task[] = []
      spyOn(storageModule, 'loadTasks').mockImplementation(() => {
        return Promise.resolve(tasks)
      })

      tasks = [
        {
          id: 'task-1',
          type: 'other',
          status: 'pending',
          priority: 5,
          description: 'Task 1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      const result1 = await listTasks()

      tasks.push({
        id: 'task-2',
        type: 'other',
        status: 'running',
        priority: 5,
        description: 'Task 2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount: 0,
        maxAttempts: 3,
        reviewHistory: [],
      })
      const result2 = await listTasks()

      expect(result1).toHaveLength(1)
      expect(result2).toHaveLength(2)
    })
  })

  describe('返回值类型', () => {
    test('返回值应为 Task 数组', async () => {
      await setupMocks()

      const result = await listTasks()

      expect(Array.isArray(result)).toBe(true)
      if (result.length > 0) {
        expect(result[0]).toHaveProperty('id')
        expect(result[0]).toHaveProperty('type')
        expect(result[0]).toHaveProperty('status')
      }
    })
  })

  describe('参数处理', () => {
    test('应正确传递 status 参数', async () => {
      await setupMocks()

      const result = await listTasks({ status: 'pending' })

      expect(result.every((t) => t.status === 'pending')).toBe(true)
    })

    test('应正确传递 status 数组参数', async () => {
      await setupMocks()

      const result = await listTasks({ status: ['pending', 'running'] })

      expect(result.every((t) => t.status === 'pending' || t.status === 'running')).toBe(true)
    })
  })

  describe('特殊字符处理', () => {
    test('任务描述包含中文应正常返回', async () => {
      await setupMocks()

      const result = await listTasks()

      expect(result.some((t) => t.description.includes('待处理'))).toBe(true)
    })

    test('任务描述包含 emoji 应正常返回', async () => {
      mockTasks = [
        {
          id: 'task-1',
          type: 'other',
          status: 'pending',
          priority: 5,
          description: '任务 🔥 进行中 ✅',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      await setupMocks()

      const result = await listTasks()

      expect(result[0].description).toContain('🔥')
      expect(result[0].description).toContain('✅')
    })
  })
})
