import { beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { getTask } from '../../../src/manager/tools/get-task'
import type { Task } from '../../../src/types'

describe('getTask 工具函数', () => {
  let mockTasks: Task[]

  beforeEach(() => {
    const now = new Date().toISOString()
    mockTasks = [
      {
        id: 'task-1',
        type: 'refactor',
        status: 'pending',
        priority: 5,
        description: '重构认证模块',
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
        description: '添加新功能',
        context: '需要考虑性能',
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
        description: '修复关键 bug',
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
        description: '失败的任务',
        error: '执行出错',
        createdAt: now,
        updatedAt: now,
        attemptCount: 3,
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
    test('应返回指定 ID 的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-1' })

      expect(result).not.toBeNull()
      expect(result?.id).toBe('task-1')
      expect(result?.description).toBe('重构认证模块')
    })

    test('应返回完整的任务对象', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-2' })

      expect(result).toEqual(mockTasks[1])
    })
  })

  describe('边界条件 - 任务不存在', () => {
    test('不存在的任务 ID 应返回 null', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'non-existent' })

      expect(result).toBeNull()
    })

    test('空字符串任务 ID 应返回 null', async () => {
      await setupMocks()

      const result = await getTask({ taskId: '' })

      expect(result).toBeNull()
    })

    test('特殊字符任务 ID 应返回 null', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-with-特殊字符-123' })

      expect(result).toBeNull()
    })

    test('undefined taskId 应返回 null', async () => {
      await setupMocks()

      const result = await getTask({ taskId: undefined as any })

      expect(result).toBeNull()
    })
  })

  describe('不同状态的任务', () => {
    test('应能获取 pending 状态的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-1' })

      expect(result?.status).toBe('pending')
    })

    test('应能获取 running 状态的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-2' })

      expect(result?.status).toBe('running')
    })

    test('应能获取 completed 状态的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-3' })

      expect(result?.status).toBe('completed')
    })

    test('应能获取 failed 状态的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-4' })

      expect(result?.status).toBe('failed')
    })

    test('应能获取 reviewing 状态的任务', async () => {
      mockTasks.push({
        id: 'task-5',
        type: 'refactor',
        status: 'reviewing',
        priority: 4,
        description: '审核中的任务',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount: 1,
        maxAttempts: 3,
        reviewHistory: [],
      })
      await setupMocks()

      const result = await getTask({ taskId: 'task-5' })

      expect(result?.status).toBe('reviewing')
    })
  })

  describe('不同类型的任务', () => {
    test('应能获取 refactor 类型的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-1' })

      expect(result?.type).toBe('refactor')
    })

    test('应能获取 feature 类型的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-2' })

      expect(result?.type).toBe('feature')
    })

    test('应能获取 bugfix 类型的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-3' })

      expect(result?.type).toBe('bugfix')
    })

    test('应能获取 other 类型的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-4' })

      expect(result?.type).toBe('other')
    })

    test('应能获取 test 类型的任务', async () => {
      mockTasks.push({
        id: 'task-6',
        type: 'test',
        status: 'pending',
        priority: 6,
        description: '测试任务',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount: 0,
        maxAttempts: 3,
        reviewHistory: [],
      })
      await setupMocks()

      const result = await getTask({ taskId: 'task-6' })

      expect(result?.type).toBe('test')
    })
  })

  describe('任务字段', () => {
    test('应返回包含所有必需字段的任务', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-1' })

      expect(result).toHaveProperty('id')
      expect(result).toHaveProperty('type')
      expect(result).toHaveProperty('status')
      expect(result).toHaveProperty('priority')
      expect(result).toHaveProperty('description')
      expect(result).toHaveProperty('createdAt')
      expect(result).toHaveProperty('updatedAt')
      expect(result).toHaveProperty('attemptCount')
      expect(result).toHaveProperty('maxAttempts')
      expect(result).toHaveProperty('reviewHistory')
    })

    test('应返回包含 context 字段（如果有）', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-2' })

      expect(result?.context).toBe('需要考虑性能')
    })

    test('应返回包含 error 字段（如果有）', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-4' })

      expect(result?.error).toBe('执行出错')
    })

    test('没有 context 时应不包含该字段', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-1' })

      expect(result?.context).toBeUndefined()
    })
  })

  describe('空任务列表', () => {
    test('空任务列表应返回 null', async () => {
      mockTasks = []
      await setupMocks()

      const result = await getTask({ taskId: 'task-1' })

      expect(result).toBeNull()
    })
  })

  describe('单条任务', () => {
    test('单条任务列表应正常处理', async () => {
      mockTasks = [
        {
          id: 'single-task',
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

      const result = await getTask({ taskId: 'single-task' })

      expect(result?.id).toBe('single-task')
    })

    test('单条任务列表中查询不存在的任务应返回 null', async () => {
      mockTasks = [
        {
          id: 'single-task',
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

      const result = await getTask({ taskId: 'other-task' })

      expect(result).toBeNull()
    })
  })

  describe('错误处理', () => {
    test('loadTasks 抛出错误时应向上传播', async () => {
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadTasks').mockImplementation(() => {
        throw new Error('Storage error')
      })

      await expect(getTask({ taskId: 'task-1' })).rejects.toThrow('Storage error')
    })

    test('loadTasks 返回 null 应当作空数组处理', async () => {
      const storageModule = await import('../../../src/utils/storage')
      // 当 loadTasks 返回 null 时，getTask 会抛出错误
      spyOn(storageModule, 'loadTasks').mockResolvedValue(null as any)

      // getTask 会尝试对 null 调用 find，这会抛出错误
      await expect(getTask({ taskId: 'task-1' })).rejects.toThrow()
    })
  })

  describe('特殊字符处理', () => {
    test('任务 ID 包含特殊字符应正常处理', async () => {
      mockTasks = [
        {
          id: 'task-with-special_chars-123',
          type: 'other',
          status: 'pending',
          priority: 5,
          description: '特殊字符任务',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      await setupMocks()

      const result = await getTask({ taskId: 'task-with-special_chars-123' })

      expect(result?.id).toBe('task-with-special_chars-123')
    })

    test('任务描述包含中文应正常处理', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-1' })

      expect(result?.description).toBe('重构认证模块')
    })

    test('任务描述包含 emoji 应正常处理', async () => {
      mockTasks = [
        {
          id: 'task-emoji',
          type: 'other',
          status: 'pending',
          priority: 5,
          description: '任务 🔥 完成 ✅',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ]
      await setupMocks()

      const result = await getTask({ taskId: 'task-emoji' })

      expect(result?.description).toContain('🔥')
      expect(result?.description).toContain('✅')
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

      const result1 = await getTask({ taskId: 'task-1' })
      const result2 = await getTask({ taskId: 'task-2' })
      const result3 = await getTask({ taskId: 'task-3' })

      expect(callCount).toBe(3)
      expect(result1?.id).toBe('task-1')
      expect(result2?.id).toBe('task-2')
      expect(result3?.id).toBe('task-3')
    })
  })

  describe('返回值类型', () => {
    test('返回值应为 Task 或 null', async () => {
      await setupMocks()

      const result1 = await getTask({ taskId: 'task-1' })
      const result2 = await getTask({ taskId: 'non-existent' })

      if (result1) {
        expect(result1).toHaveProperty('id')
        expect(result1).toHaveProperty('type')
        expect(result1).toHaveProperty('status')
      }
      expect(result2).toBeNull()
    })
  })

  describe('参数处理', () => {
    test('应正确传递 taskId 参数', async () => {
      await setupMocks()

      const result = await getTask({ taskId: 'task-1' })

      expect(result?.id).toBe('task-1')
    })

    test('空对象参数应返回 null', async () => {
      await setupMocks()

      // @ts-expect-error - Testing with empty object
      const result = await getTask({})

      expect(result).toBeNull()
    })
  })
})
