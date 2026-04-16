import { beforeEach, describe, expect, test } from 'bun:test'
import type { Task } from '../../../src/types'
import { createTask } from '../../../src/manager/tools/create-task'

describe('createTask 工具函数', () => {
  let mockTasks: Task[]
  let addTaskCalls: Array<{ description: string; type?: Task['type']; priority?: number }>
  let updateTaskCalls: Array<{ taskId: string; updates: Partial<Task> }>

  beforeEach(() => {
    mockTasks = []
    addTaskCalls = []
    updateTaskCalls = []
  })

  function createDeps() {
    return {
      addTaskManually: async (
        description: string,
        type?: Task['type'],
        priority?: number,
      ): Promise<Task> => {
        addTaskCalls.push({ description, type, priority })
        const task: Task = {
          id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          description,
          type: type || 'other',
          status: 'pending',
          priority: priority ?? 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        }
        mockTasks.push(task)
        return task
      },
      updateTask: async (taskId: string, updates: Partial<Task>): Promise<Task | null> => {
        updateTaskCalls.push({ taskId, updates })
        const task = mockTasks.find((t) => t.id === taskId)
        if (task) {
          Object.assign(task, updates)
          return task
        }
        return null
      },
    }
  }

  describe('基本功能', () => {
    test('成功创建中文任务', async () => {
      const deps = createDeps()
      const description = '重构用户认证模块'

      const result = await createTask({ description }, deps)

      expect(result.description).toBe(description)
      expect(result.type).toBe('other')
      expect(result.priority).toBe(3)
      expect(result.status).toBe('pending')
      expect(addTaskCalls).toHaveLength(1)
    })

    test('应支持自定义类型', async () => {
      const deps = createDeps()
      const description = '优化数据库查询'

      const result = await createTask({ description, type: 'optimize' }, deps)

      expect(result.type).toBe('optimize')
      expect(addTaskCalls[0].type).toBe('optimize')
    })

    test('应支持自定义优先级', async () => {
      const deps = createDeps()
      const description = '修复登录 bug'

      const result = await createTask({ description, priority: 5 }, deps)

      expect(result.priority).toBe(5)
      expect(addTaskCalls[0].priority).toBe(5)
    })

    test('应支持添加上下文', async () => {
      const deps = createDeps()
      const description = '实现新功能'
      const context = '需要考虑性能和安全性'

      const result = await createTask({ description, context }, deps)

      expect(result.context).toBe(context)
      expect(updateTaskCalls).toHaveLength(1)
    })
  })

  describe('边界条件 - 中文验证', () => {
    test('纯英文字符应抛出错误', async () => {
      const deps = createDeps()

      await expect(createTask({ description: 'Refactor auth module' }, deps)).rejects.toThrow(
        '任务描述必须使用中文',
      )
    })

    test('空字符串应抛出错误', async () => {
      const deps = createDeps()

      await expect(createTask({ description: '' }, deps)).rejects.toThrow('任务描述必须使用中文')
    })

    test('仅包含空格的字符串应抛出错误', async () => {
      const deps = createDeps()

      await expect(createTask({ description: '   ' }, deps)).rejects.toThrow(
        '任务描述必须使用中文',
      )
    })

    test('中英混合应通过验证', async () => {
      const deps = createDeps()
      const description = '重构 UserAuth 类，添加 JWT 支持'

      const result = await createTask({ description }, deps)

      expect(result.description).toBe(description)
    })

    test('中英混合带标点应通过验证', async () => {
      const deps = createDeps()
      const description = '修复 API 接口 /api/login 的 bug'

      const result = await createTask({ description }, deps)

      expect(result.description).toBe(description)
    })

    test('带数字的中文应通过验证', async () => {
      const deps = createDeps()
      const description = '实现 HTTP 2.0 支持'

      const result = await createTask({ description }, deps)

      expect(result.description).toBe(description)
    })

    test('包含 emoji 的中文应通过验证', async () => {
      const deps = createDeps()
      const description = '优化性能 ⚡，减少内存占用'

      const result = await createTask({ description }, deps)

      expect(result.description).toBe(description)
    })

    test('单字中文应通过验证', async () => {
      const deps = createDeps()
      const description = '修'

      const result = await createTask({ description }, deps)

      expect(result.description).toBe('修')
    })

    test('超长中文描述应正常处理', async () => {
      const deps = createDeps()
      const description = '这是一个非常非常长的任务描述' + '很长的内容'.repeat(1000)

      const result = await createTask({ description }, deps)

      expect(result.description).toBe(description)
    })
  })

  describe('边界条件 - 参数', () => {
    test('默认类型应为 other', async () => {
      const deps = createDeps()
      const description = '测试任务'

      const result = await createTask({ description }, deps)

      expect(result.type).toBe('other')
    })

    test('默认优先级应为 3', async () => {
      const deps = createDeps()
      const description = '测试任务'

      const result = await createTask({ description }, deps)

      expect(result.priority).toBe(3)
    })

    test('优先级为 0 应正常处理', async () => {
      const deps = createDeps()
      const description = '测试任务'

      const result = await createTask({ description, priority: 0 }, deps)

      expect(result.priority).toBe(0)
    })

    test('高优先级应正常处理', async () => {
      const deps = createDeps()
      const description = '测试任务'

      const result = await createTask({ description, priority: 10 }, deps)

      expect(result.priority).toBe(10)
    })

    test('负优先级应正常处理', async () => {
      const deps = createDeps()
      const description = '测试任务'

      const result = await createTask({ description, priority: -1 }, deps)

      expect(result.priority).toBe(-1)
    })

    test('空上下文应不调用 updateTask', async () => {
      const deps = createDeps()
      const description = '测试任务'

      await createTask({ description, context: '' }, deps)

      expect(updateTaskCalls).toHaveLength(0)
    })

    test('仅空格的上下文应调用 updateTask（空格被视为有效上下文）', async () => {
      const deps = createDeps()
      const description = '测试任务'

      await createTask({ description, context: '   ' }, deps)

      // context 为 '   ' 是 truthy，所以会调用 updateTask
      expect(updateTaskCalls).toHaveLength(1)
      expect(updateTaskCalls[0].updates.context).toBe('')
    })

    test('上下文应 trim 空格', async () => {
      const deps = createDeps()
      const description = '测试任务'
      const context = '  上下文内容  '

      await createTask({ description, context }, deps)

      expect(updateTaskCalls[0].updates.context).toBe('上下文内容')
    })

    test('超长上下文应正常处理', async () => {
      const deps = createDeps()
      const description = '测试任务'
      const context = '很长的上下文' + '内容'.repeat(10000)

      const result = await createTask({ description, context }, deps)

      expect(result.context).toBe(context)
    })
  })

  describe('错误处理', () => {
    test('addTaskManually 失败时应抛出错误', async () => {
      const deps = {
        addTaskManually: async () => {
          throw new Error('Storage error')
        },
        updateTask: async () => null,
      }

      await expect(
        createTask({ description: '测试任务' }, deps as any),
      ).rejects.toThrow('Storage error')
    })

    test('updateTask 失败时应返回原任务', async () => {
      const originalTask: Task = {
        id: 'task-1',
        description: '测试任务',
        type: 'other',
        status: 'pending',
        priority: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount: 0,
        maxAttempts: 3,
        reviewHistory: [],
      }
      const deps = {
        addTaskManually: async () => originalTask,
        updateTask: async () => null,
      }

      const result = await createTask({ description: '测试任务', context: '上下文' }, deps as any)

      expect(result).toEqual(originalTask)
    })
  })

  describe('连续创建', () => {
    test('连续创建多个任务应正常处理', async () => {
      const deps = createDeps()

      const task1 = await createTask({ description: '任务一' }, deps)
      const task2 = await createTask({ description: '任务二', type: 'refactor' }, deps)
      const task3 = await createTask({ description: '任务三', priority: 5 }, deps)

      expect(task1.description).toBe('任务一')
      expect(task2.description).toBe('任务二')
      expect(task2.type).toBe('refactor')
      expect(task3.description).toBe('任务三')
      expect(task3.priority).toBe(5)
      expect(addTaskCalls).toHaveLength(3)
    })

    test('每个任务应有唯一的 ID', async () => {
      const deps = createDeps()

      const task1 = await createTask({ description: '任务一' }, deps)
      const task2 = await createTask({ description: '任务二' }, deps)
      const task3 = await createTask({ description: '任务三' }, deps)

      expect(task1.id).not.toBe(task2.id)
      expect(task2.id).not.toBe(task3.id)
      expect(task1.id).not.toBe(task3.id)
    })
  })

  describe('返回值结构', () => {
    test('返回任务应包含所有必需字段', async () => {
      const deps = createDeps()
      const description = '测试任务'

      const result = await createTask({ description }, deps)

      expect(result).toHaveProperty('id')
      expect(result).toHaveProperty('description')
      expect(result).toHaveProperty('type')
      expect(result).toHaveProperty('status')
      expect(result).toHaveProperty('priority')
      expect(result).toHaveProperty('createdAt')
      expect(result).toHaveProperty('updatedAt')
      expect(result).toHaveProperty('attemptCount')
      expect(result).toHaveProperty('maxAttempts')
      expect(result).toHaveProperty('reviewHistory')
    })

    test('返回任务的状态应为 pending', async () => {
      const deps = createDeps()

      const result = await createTask({ description: '测试' }, deps)

      expect(result.status).toBe('pending')
    })

    test('返回任务的 attemptCount 应为 0', async () => {
      const deps = createDeps()

      const result = await createTask({ description: '测试' }, deps)

      expect(result.attemptCount).toBe(0)
    })

    test('返回任务的 reviewHistory 应为空数组', async () => {
      const deps = createDeps()

      const result = await createTask({ description: '测试' }, deps)

      expect(result.reviewHistory).toEqual([])
    })
  })
})
