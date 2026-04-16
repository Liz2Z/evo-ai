import { beforeEach, describe, expect, test } from 'bun:test'
import { cancelTaskTool } from '../../../src/manager/tools/cancel-task'

describe('cancelTaskTool 工具函数', () => {
  let cancelTaskCalls: string[]
  let cancelTaskResults: Map<string, boolean>

  beforeEach(() => {
    cancelTaskCalls = []
    cancelTaskResults = new Map()
  })

  function createDeps() {
    return {
      cancelTask: async (taskId: string) => {
        cancelTaskCalls.push(taskId)
        return cancelTaskResults.get(taskId) ?? true
      },
    }
  }

  describe('基本功能', () => {
    test('成功取消任务应返回 cancelled', async () => {
      const taskId = 'task-1'
      cancelTaskResults.set(taskId, true)
      const deps = createDeps()

      const result = await cancelTaskTool({ taskId }, deps)

      expect(result.status).toBe('cancelled')
      expect(result.taskId).toBe(taskId)
      expect(cancelTaskCalls).toEqual([taskId])
    })

    test('取消失败应返回 noop', async () => {
      const taskId = 'task-1'
      cancelTaskResults.set(taskId, false)
      const deps = createDeps()

      const result = await cancelTaskTool({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.taskId).toBe(taskId)
    })
  })

  describe('边界条件', () => {
    test('取消不存在的任务应返回 noop', async () => {
      const taskId = 'non-existent'
      cancelTaskResults.set(taskId, false)
      const deps = createDeps()

      const result = await cancelTaskTool({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.taskId).toBe(taskId)
    })

    test('空任务 ID 应正常处理', async () => {
      const taskId = ''
      cancelTaskResults.set(taskId, false)
      const deps = createDeps()

      const result = await cancelTaskTool({ taskId }, deps)

      expect(result.status).toBe('noop')
      expect(result.taskId).toBe('')
    })

    test('特殊字符任务 ID 应正常处理', async () => {
      const taskId = 'task-with-特殊字符-123'
      cancelTaskResults.set(taskId, true)
      const deps = createDeps()

      const result = await cancelTaskTool({ taskId }, deps)

      expect(result.status).toBe('cancelled')
      expect(result.taskId).toBe(taskId)
    })

    test('超长任务 ID 应正常处理', async () => {
      const taskId = 'a'.repeat(1000)
      cancelTaskResults.set(taskId, true)
      const deps = createDeps()

      const result = await cancelTaskTool({ taskId }, deps)

      expect(result.status).toBe('cancelled')
    })

    test('包含 emoji 的任务 ID 应正常处理', async () => {
      const taskId = 'task-🔥-123'
      cancelTaskResults.set(taskId, true)
      const deps = createDeps()

      const result = await cancelTaskTool({ taskId }, deps)

      expect(result.status).toBe('cancelled')
    })
  })

  describe('连续调用', () => {
    test('连续取消同一任务应正常处理', async () => {
      const taskId = 'task-1'
      cancelTaskResults.set(taskId, true)
      const deps = createDeps()

      const result1 = await cancelTaskTool({ taskId }, deps)
      const result2 = await cancelTaskTool({ taskId }, deps)

      expect(result1.status).toBe('cancelled')
      expect(result2.status).toBe('cancelled')
      expect(cancelTaskCalls).toEqual([taskId, taskId])
    })

    test('取消多个不同任务应正常处理', async () => {
      cancelTaskResults.set('task-1', true)
      cancelTaskResults.set('task-2', true)
      cancelTaskResults.set('task-3', false)
      const deps = createDeps()

      const results = await Promise.all([
        cancelTaskTool({ taskId: 'task-1' }, deps),
        cancelTaskTool({ taskId: 'task-2' }, deps),
        cancelTaskTool({ taskId: 'task-3' }, deps),
      ])

      expect(results[0].status).toBe('cancelled')
      expect(results[1].status).toBe('cancelled')
      expect(results[2].status).toBe('noop')
      expect(cancelTaskCalls).toEqual(['task-1', 'task-2', 'task-3'])
    })
  })

  describe('返回值结构', () => {
    test('应始终包含 status 和 taskId 字段', async () => {
      const taskId = 'task-1'
      const deps = createDeps()

      const result = await cancelTaskTool({ taskId }, deps)

      expect(result).toHaveProperty('status')
      expect(result).toHaveProperty('taskId')
      expect(Object.keys(result)).toHaveLength(2)
    })

    test('status 应该是 cancelled 或 noop', async () => {
      const taskId = 'task-1'
      const deps = createDeps()

      const result = await cancelTaskTool({ taskId }, deps)

      expect(['cancelled', 'noop']).toContain(result.status)
    })
  })

  describe('参数处理', () => {
    test('应正确传递 taskId 参数', async () => {
      const taskId = 'test-task-id'
      cancelTaskResults.set(taskId, true)
      const deps = createDeps()

      await cancelTaskTool({ taskId }, deps)

      expect(cancelTaskCalls[0]).toBe(taskId)
    })
  })
})
