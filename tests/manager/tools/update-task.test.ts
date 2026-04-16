import { beforeAll, beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { updateTask } from '../../../src/manager/tools/update-task'
import type { Task } from '../../../src/types'

describe('updateTask 工具函数', () => {
  let mockTasks: Map<string, Task>
  let getMockTasks: () => Map<string, Task>
  let storageModule: any
  let mockError: Error | null = null
  let mockReturnNull: boolean = false

  beforeAll(async () => {
    storageModule = await import('../../../src/utils/storage')
    // 使用函数来获取最新的 mockTasks，而不是闭包引用
    getMockTasks = () => mockTasks
    let callCount = 0
    spyOn(storageModule, 'updateTask').mockImplementation(
      async (taskId: string, updates: Partial<Task>) => {
        // 检查是否应该抛出错误
        if (mockError) {
          const error = mockError
          mockError = null
          throw error
        }

        const tasks = getMockTasks()
        const task = tasks.get(taskId)

        // 检查是否应该返回 null
        if (mockReturnNull || !task) {
          mockReturnNull = false
          return null
        }

        // 确保每次调用都生成不同的时间戳
        const originalUpdatedAt = task.updatedAt
        let newUpdatedAt = new Date().toISOString()
        while (newUpdatedAt === originalUpdatedAt) {
          await new Promise((resolve) => setTimeout(resolve, 1))
          newUpdatedAt = new Date().toISOString()
        }
        // 过滤掉 undefined 值，只保留有定义的更新
        const definedUpdates: Partial<Task> = {}
        if (updates) {
          for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
              (definedUpdates as any)[key] = value
            }
          }
        }
        const updated = { ...task, ...definedUpdates, updatedAt: newUpdatedAt }
        tasks.set(taskId, updated)
        return updated
      },
    )
  })

  function getInitialMockTasks() {
    const now = new Date().toISOString()
    return new Map([
      [
        'task-1',
        {
          id: 'task-1',
          type: 'refactor',
          status: 'pending',
          priority: 5,
          description: '原始任务',
          createdAt: now,
          updatedAt: now,
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ],
      [
        'task-2',
        {
          id: 'task-2',
          type: 'feature',
          status: 'running',
          priority: 3,
          description: '运行中任务',
          context: '原始上下文',
          createdAt: now,
          updatedAt: now,
          attemptCount: 1,
          maxAttempts: 3,
          reviewHistory: [],
        },
      ],
      [
        'task-3',
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
      ],
    ])
  }

  beforeEach(() => {
    mockTasks = getInitialMockTasks()
  })

  describe('基本功能', () => {
    test('应成功更新任务', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { status: 'running' },
      })

      expect(result).not.toBeNull()
      expect(result?.id).toBe('task-1')
      expect(result?.status).toBe('running')
    })

    test('应更新多个字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { status: 'running', priority: 7, description: '更新后的任务' },
      })

      expect(result?.status).toBe('running')
      expect(result?.priority).toBe(7)
      expect(result?.description).toBe('更新后的任务')
    })

    test('应保留未更新的字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { priority: 8 },
      })

      expect(result?.priority).toBe(8)
      expect(result?.description).toBe('原始任务')
      expect(result?.type).toBe('refactor')
    })
  })

  describe('边界条件 - 任务不存在', () => {
    test('不存在的任务应返回 null', async () => {

      const result = await updateTask({
        taskId: 'non-existent',
        patch: { status: 'running' },
      })

      expect(result).toBeNull()
    })

    test('空任务 ID 应返回 null', async () => {

      const result = await updateTask({
        taskId: '',
        patch: { status: 'running' },
      })

      expect(result).toBeNull()
    })

    test('特殊字符任务 ID 应返回 null', async () => {

      const result = await updateTask({
        taskId: 'task-with-特殊字符-123',
        patch: { status: 'running' },
      })

      expect(result).toBeNull()
    })
  })

  describe('可更新字段', () => {
    test('应更新 status 字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { status: 'running' },
      })

      expect(result?.status).toBe('running')
    })

    test('应更新 priority 字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { priority: 10 },
      })

      expect(result?.priority).toBe(10)
    })

    test('应更新 description 字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { description: '新的描述' },
      })

      expect(result?.description).toBe('新的描述')
    })

    test('应更新 context 字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { context: '新的上下文' },
      })

      expect(result?.context).toBe('新的上下文')
    })

    test('应更新 error 字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { error: '错误信息' },
      })

      expect(result?.error).toBe('错误信息')
    })

    test('应更新 type 字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { type: 'feature' },
      })

      expect(result?.type).toBe('feature')
    })

    test('应更新 attemptCount 字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { attemptCount: 2 },
      })

      expect(result?.attemptCount).toBe(2)
    })

    test('应更新 reviewHistory 字段', async () => {

      const newHistory = [
        {
          attempt: 1,
          agentId: 'reviewer-1',
          review: {
            taskId: 'task-1',
            verdict: 'approve',
            confidence: 0.9,
            summary: 'Good',
            issues: [],
            suggestions: [],
          },
          timestamp: new Date().toISOString(),
        },
      ]
      const result = await updateTask({
        taskId: 'task-1',
        patch: { reviewHistory: newHistory },
      })

      expect(result?.reviewHistory).toEqual(newHistory)
    })
  })

  describe('空 patch', () => {
    test('空 patch 应只更新 updatedAt', async () => {

      const beforeUpdate = mockTasks.get('task-1')!.updatedAt
      const result = await updateTask({
        taskId: 'task-1',
        patch: {},
      })

      expect(result).not.toBeNull()
      expect(result?.id).toBe('task-1')
      expect(result?.updatedAt).not.toBe(beforeUpdate)
    })

    test('undefined 字段在 patch 中应被忽略', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { status: undefined as any },
      })

      expect(result?.status).toBe('pending')
    })
  })

  describe('特殊值处理', () => {
    test('空字符串 description 应正常更新', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { description: '' },
      })

      expect(result?.description).toBe('')
    })

    test('零 priority 应正常更新', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { priority: 0 },
      })

      expect(result?.priority).toBe(0)
    })

    test('负数 priority 应正常更新', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { priority: -1 },
      })

      expect(result?.priority).toBe(-1)
    })

    test('删除 context 字段（设为 undefined）应正常处理', async () => {

      const result = await updateTask({
        taskId: 'task-2',
        patch: { context: undefined as any },
      })

      // The actual behavior depends on updateTaskStorage implementation
      expect(result).not.toBeNull()
    })
  })

  describe('特殊字符处理', () => {
    test('中文 description 应正常更新', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { description: '这是中文描述' },
      })

      expect(result?.description).toBe('这是中文描述')
    })

    test('包含 emoji 的 description 应正常更新', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { description: '任务 🔥 完成 ✅' },
      })

      expect(result?.description).toContain('🔥')
      expect(result?.description).toContain('✅')
    })

    test('包含特殊字符的 description 应正常更新', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { description: '包含 "引号" 和 \'撇号\'' },
      })

      expect(result?.description).toContain('引号')
      expect(result?.description).toContain('撇号')
    })

    test('包含换行符的 context 应正常更新', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { context: '第一行\n第二行\n第三行' },
      })

      expect(result?.context).toContain('\n')
    })
  })

  describe('不同状态的任务', () => {
    test('应能更新 pending 任务', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { priority: 10 },
      })

      expect(result?.status).toBe('pending')
      expect(result?.priority).toBe(10)
    })

    test('应能更新 running 任务', async () => {

      const result = await updateTask({
        taskId: 'task-2',
        patch: { context: '更新的上下文' },
      })

      expect(result?.status).toBe('running')
      expect(result?.context).toBe('更新的上下文')
    })

    test('应能更新 completed 任务', async () => {

      const result = await updateTask({
        taskId: 'task-3',
        patch: { description: '更新已完成任务的描述' },
      })

      expect(result?.status).toBe('completed')
      expect(result?.description).toBe('更新已完成任务的描述')
    })
  })

  describe('连续更新', () => {
    test('连续更新同一任务应成功', async () => {

      const result1 = await updateTask({
        taskId: 'task-1',
        patch: { priority: 7 },
      })
      const result2 = await updateTask({
        taskId: 'task-1',
        patch: { status: 'running' },
      })
      const result3 = await updateTask({
        taskId: 'task-1',
        patch: { description: '最终描述' },
      })

      expect(result1?.priority).toBe(7)
      expect(result2?.status).toBe('running')
      expect(result3?.description).toBe('最终描述')
    })

    test('连续更新不同任务应成功', async () => {

      const result1 = await updateTask({
        taskId: 'task-1',
        patch: { priority: 8 },
      })
      const result2 = await updateTask({
        taskId: 'task-2',
        patch: { priority: 9 },
      })
      const result3 = await updateTask({
        taskId: 'task-3',
        patch: { priority: 10 },
      })

      expect(result1?.priority).toBe(8)
      expect(result2?.priority).toBe(9)
      expect(result3?.priority).toBe(10)
    })
  })

  describe('错误处理', () => {
    test('updateTaskStorage 抛出错误时应向上传播', async () => {
      mockError = new Error('Storage error')

      await expect(
        updateTask({
          taskId: 'task-1',
          patch: { status: 'running' },
        }),
      ).rejects.toThrow('Storage error')
    })

    test('updateTaskStorage 返回 null 应返回 null', async () => {
      mockReturnNull = true

      const result = await updateTask({
        taskId: 'task-1',
        patch: { status: 'running' },
      })

      expect(result).toBeNull()
    })
  })

  describe('返回值类型', () => {
    test('成功时应返回 Task 对象', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: { priority: 7 },
      })

      expect(result).not.toBeNull()
      expect(result).toHaveProperty('id')
      expect(result).toHaveProperty('type')
      expect(result).toHaveProperty('status')
    })

    test('失败时应返回 null', async () => {

      const result = await updateTask({
        taskId: 'non-existent',
        patch: { status: 'running' },
      })

      expect(result).toBeNull()
    })
  })

  describe('参数验证', () => {
    test('必须提供 taskId', async () => {

      // @ts-expect-error - Testing without taskId
      const result = await updateTask({ patch: { status: 'running' } })

      expect(result).toBeNull()
    })

    test('必须提供 patch', async () => {

      // @ts-expect-error - Testing without patch
      const result = await updateTask({ taskId: 'task-1' })

      expect(result).not.toBeNull() // Empty patch is valid
    })
  })

  describe('updatedAt 自动更新', () => {
    test('更新任务时应自动更新 updatedAt', async () => {
      const beforeUpdate = mockTasks.get('task-1')!.updatedAt

      await new Promise((resolve) => setTimeout(resolve, 10)) // Ensure time difference

      const result = await updateTask({
        taskId: 'task-1',
        patch: { priority: 7 },
      })

      expect(result?.updatedAt).not.toBe(beforeUpdate)
    })
  })

  describe('复杂更新场景', () => {
    test('应能同时更新多个不相关字段', async () => {

      const result = await updateTask({
        taskId: 'task-1',
        patch: {
          status: 'running',
          priority: 8,
          description: '新描述',
          context: '新上下文',
          attemptCount: 1,
        },
      })

      expect(result?.status).toBe('running')
      expect(result?.priority).toBe(8)
      expect(result?.description).toBe('新描述')
      expect(result?.context).toBe('新上下文')
      expect(result?.attemptCount).toBe(1)
    })

    test('应能用新值覆盖现有字段', async () => {

      const result = await updateTask({
        taskId: 'task-2',
        patch: { context: '覆盖的上下文' },
      })

      expect(result?.context).toBe('覆盖的上下文')
      expect(result?.context).not.toBe('原始上下文')
    })
  })
})
