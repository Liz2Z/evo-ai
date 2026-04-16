import { beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { retryTask } from '../../../src/manager/tools/retry-task'
import type { Task } from '../../../src/types'

describe('retryTask 工具函数', () => {
  let mockTasks: Map<string, Task>

  beforeEach(() => {
    mockTasks = new Map()
    const now = new Date().toISOString()
    
    mockTasks.set('task-failed', {
      id: 'task-failed',
      type: 'refactor',
      status: 'failed',
      priority: 5,
      description: '失败的任务',
      context: '原始上下文',
      error: '执行出错',
      createdAt: now,
      updatedAt: now,
      attemptCount: 2,
      maxAttempts: 3,
      reviewHistory: [],
    })

    mockTasks.set('task-pending', {
      id: 'task-pending',
      type: 'feature',
      status: 'pending',
      priority: 3,
      description: '待处理任务',
      createdAt: now,
      updatedAt: now,
      attemptCount: 0,
      maxAttempts: 3,
      reviewHistory: [],
    })

    mockTasks.set('task-running', {
      id: 'task-running',
      type: 'bugfix',
      status: 'running',
      priority: 7,
      description: '运行中任务',
      createdAt: now,
      updatedAt: now,
      attemptCount: 1,
      maxAttempts: 3,
      reviewHistory: [],
    })

    mockTasks.set('task-completed', {
      id: 'task-completed',
      type: 'other',
      status: 'completed',
      priority: 2,
      description: '已完成任务',
      createdAt: now,
      updatedAt: now,
      attemptCount: 1,
      maxAttempts: 3,
      reviewHistory: [],
    })

    mockTasks.set('task-reviewing', {
      id: 'task-reviewing',
      type: 'test',
      status: 'reviewing',
      priority: 4,
      description: '审核中任务',
      createdAt: now,
      updatedAt: now,
      attemptCount: 1,
      maxAttempts: 3,
      reviewHistory: [],
    })
  })

  function createDeps() {
    return {
      getTaskById: async (taskId: string) => mockTasks.get(taskId) || null,
    }
  }

  describe('基本功能', () => {
    test('成功重试 failed 状态任务', async () => {
      const deps = createDeps()
      
      // Mock updateTask
      const storageModule = await import('../../../src/utils/storage')
      const originalUpdateTask = storageModule.updateTask
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      const result = await retryTask({ taskId: 'task-failed' }, deps)

      expect(result.status).toBe('retried')
      expect(result.taskId).toBe('task-failed')
      expect(updatedTask?.status).toBe('pending')
    })

    test('应保持原有上下文', async () => {
      const deps = createDeps()

      const storageModule = await import('../../../src/utils/storage')
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      await retryTask({ taskId: 'task-failed' }, deps)

      expect(updatedTask?.context).toBe('原始上下文')
    })
  })

  describe('边界条件 - 任务不存在', () => {
    test('不存在的任务应返回 not_found', async () => {
      const deps = createDeps()

      const result = await retryTask({ taskId: 'non-existent' }, deps)

      expect(result.status).toBe('not_found')
      expect(result.taskId).toBe('non-existent')
    })

    test('空任务 ID 应返回 not_found', async () => {
      const deps = createDeps()

      const result = await retryTask({ taskId: '' }, deps)

      expect(result.status).toBe('not_found')
      expect(result.taskId).toBe('')
    })

    test('特殊字符任务 ID 应返回 not_found', async () => {
      const deps = createDeps()

      const result = await retryTask({ taskId: 'task-with-特殊字符-123' }, deps)

      expect(result.status).toBe('not_found')
    })
  })

  describe('边界条件 - 任务状态不合法', () => {
    test('pending 状态任务应返回 noop', async () => {
      const deps = createDeps()

      const result = await retryTask({ taskId: 'task-pending' }, deps)

      expect(result.status).toBe('noop')
      expect(result.taskId).toBe('task-pending')
    })

    test('running 状态任务应返回 noop', async () => {
      const deps = createDeps()

      const result = await retryTask({ taskId: 'task-running' }, deps)

      expect(result.status).toBe('noop')
      expect(result.taskId).toBe('task-running')
    })

    test('completed 状态任务应返回 noop', async () => {
      const deps = createDeps()

      const result = await retryTask({ taskId: 'task-completed' }, deps)

      expect(result.status).toBe('noop')
      expect(result.taskId).toBe('task-completed')
    })

    test('reviewing 状态任务应返回 noop', async () => {
      const deps = createDeps()

      const result = await retryTask({ taskId: 'task-reviewing' }, deps)

      expect(result.status).toBe('noop')
      expect(result.taskId).toBe('task-reviewing')
    })

    test('只有 failed 状态任务可以重试', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          return updated
        }
        return null
      })

      const result = await retryTask({ taskId: 'task-failed' }, deps)

      expect(result.status).toBe('retried')
    })
  })

  describe('additionalContext 参数', () => {
    test('无 additionalContext 时应保持原上下文', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      await retryTask({ taskId: 'task-failed' }, deps)

      expect(updatedTask?.context).toBe('原始上下文')
    })

    test('有 additionalContext 且无原上下文时应使用新上下文', async () => {
      mockTasks.set('task-no-context', {
        id: 'task-no-context',
        type: 'refactor',
        status: 'failed',
        priority: 5,
        description: '无上下文任务',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount: 1,
        maxAttempts: 3,
        reviewHistory: [],
      })
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      await retryTask({ taskId: 'task-no-context', additionalContext: '新的上下文' }, deps)

      expect(updatedTask?.context).toBe('新的上下文')
    })

    test('有 additionalContext 且有原上下文时应合并', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      await retryTask({ taskId: 'task-failed', additionalContext: '额外的上下文信息' }, deps)

      expect(updatedTask?.context).toContain('原始上下文')
      expect(updatedTask?.context).toContain('额外的上下文信息')
    })

    test('空字符串 additionalContext 应不改变上下文', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      await retryTask({ taskId: 'task-failed', additionalContext: '' }, deps)

      expect(updatedTask?.context).toBe('原始上下文')
    })

    test('only spaces additionalContext 应不改变上下文', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      await retryTask({ taskId: 'task-failed', additionalContext: '   ' }, deps)

      expect(updatedTask?.context).toBe('原始上下文')
    })

    test('超长 additionalContext 应正常处理', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      const longContext = '很长的上下文' + '内容'.repeat(1000)
      await retryTask({ taskId: 'task-failed', additionalContext: longContext }, deps)

      expect(updatedTask?.context).toContain('很长的上下文')
      expect(updatedTask?.context).length.toBeGreaterThan(1000)
    })

    test('包含特殊字符的 additionalContext 应正常处理', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      const specialContext = '包含 "引号" 和 \'撇号\' 和 \n 换行 \t 制表符'
      await retryTask({ taskId: 'task-failed', additionalContext: specialContext }, deps)

      expect(updatedTask?.context).toContain('引号')
      expect(updatedTask?.context).toContain('撇号')
    })

    test('包含 emoji 的 additionalContext 应正常处理', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      let updatedTask: Task | null = null
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          updatedTask = updated
          return updated
        }
        return null
      })

      const emojiContext = '包含 emoji 🎉 和 🔥 和 ✅'
      await retryTask({ taskId: 'task-failed', additionalContext: emojiContext }, deps)

      expect(updatedTask?.context).toContain('🎉')
      expect(updatedTask?.context).toContain('🔥')
      expect(updatedTask?.context).toContain('✅')
    })
  })

  describe('连续调用', () => {
    test('连续重试同一任务应成功', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          // Reset to failed first
          if (updates.status === 'pending') {
            const updated = { ...task, ...updates, status: 'failed' as const }
            mockTasks.set(taskId, updated)
            return updated
          }
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          return updated
        }
        return null
      })

      const result1 = await retryTask({ taskId: 'task-failed' }, deps)
      // Reset to failed for second call
      mockTasks.set('task-failed', {
        ...mockTasks.get('task-failed')!,
        status: 'failed',
      })
      const result2 = await retryTask({ taskId: 'task-failed' }, deps)

      expect(result1.status).toBe('retried')
      expect(result2.status).toBe('retried')
    })
  })

  describe('返回值结构', () => {
    test('返回值应包含 status 和 taskId', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          return updated
        }
        return null
      })

      const result = await retryTask({ taskId: 'task-failed' }, deps)

      expect(result).toHaveProperty('status')
      expect(result).toHaveProperty('taskId')
      expect(Object.keys(result)).toHaveLength(2)
    })

    test('status 应该是 retried、noop 或 not_found', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'updateTask').mockImplementation(async (taskId, updates) => {
        const task = mockTasks.get(taskId)
        if (task) {
          const updated = { ...task, ...updates }
          mockTasks.set(taskId, updated)
          return updated
        }
        return null
      })

      const result1 = await retryTask({ taskId: 'task-failed' }, deps)
      const result2 = await retryTask({ taskId: 'task-pending' }, deps)
      const result3 = await retryTask({ taskId: 'non-existent' }, deps)

      expect(['retried', 'noop', 'not_found']).toContain(result1.status)
      expect(['retried', 'noop', 'not_found']).toContain(result2.status)
      expect(['retried', 'noop', 'not_found']).toContain(result3.status)
    })
  })

  describe('错误处理', () => {
    test('getTaskById 抛出错误时应向上传播', async () => {
      const deps = {
        getTaskById: async () => {
          throw new Error('Database error')
        },
      }

      await expect(retryTask({ taskId: 'task-failed' }, deps)).rejects.toThrow(
        'Database error',
      )
    })

    test('updateTask 失败时应抛出错误', async () => {
      const deps = createDeps()
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'updateTask').mockImplementation(() => {
        throw new Error('Update failed')
      })

      await expect(retryTask({ taskId: 'task-failed' }, deps)).rejects.toThrow('Update failed')
    })
  })
})
