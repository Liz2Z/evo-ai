import { beforeEach, describe, expect, test } from 'bun:test'
import { commitCurrentTaskTool } from '../../../src/manager/tools/commit-current-task'
import type { CommitTaskResult } from '../../../src/manager/runtime'

describe('commitCurrentTaskTool 工具函数', () => {
  let mockCommitResult: CommitTaskResult | null
  let commitCurrentTaskCalls: number

  beforeEach(() => {
    mockCommitResult = null
    commitCurrentTaskCalls = 0
  })

  function createDeps() {
    return {
      commitCurrentTask: async () => {
        commitCurrentTaskCalls++
        return (
          mockCommitResult ?? {
            status: 'committed',
            taskId: 'task-1',
            message: 'Successfully committed',
          }
        )
      },
    }
  }

  describe('基本功能', () => {
    test('应调用 commitCurrentTask 并返回结果', async () => {
      mockCommitResult = {
        status: 'committed',
        taskId: 'task-1',
        message: 'Task committed successfully',
      }
      const deps = createDeps()

      const result = await commitCurrentTaskTool(undefined, deps)

      expect(result).toEqual(mockCommitResult)
      expect(commitCurrentTaskCalls).toBe(1)
    })

    test('应传递所有返回字段', async () => {
      mockCommitResult = {
        status: 'committed',
        taskId: 'task-123',
        message: 'All changes committed',
        commitHash: 'abc123',
      }
      const deps = createDeps()

      const result = await commitCurrentTaskTool(undefined, deps)

      expect(result.status).toBe('committed')
      expect(result.taskId).toBe('task-123')
      expect(result.message).toBe('All changes committed')
      expect(result.commitHash).toBe('abc123')
    })
  })

  describe('边界条件', () => {
    test('noop 状态应正确返回', async () => {
      mockCommitResult = {
        status: 'noop',
        taskId: 'task-1',
        message: 'No current task to commit',
      }
      const deps = createDeps()

      const result = await commitCurrentTaskTool(undefined, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('No current task')
    })

    test('failed 状态应正确返回', async () => {
      mockCommitResult = {
        status: 'failed',
        taskId: 'task-1',
        message: 'Commit failed: merge conflict',
      }
      const deps = createDeps()

      const result = await commitCurrentTaskTool(undefined, deps)

      expect(result.status).toBe('failed')
      expect(result.message).toContain('merge conflict')
    })

    test('not_found 状态应正确返回', async () => {
      mockCommitResult = {
        status: 'not_found',
        message: 'Task not found',
      }
      const deps = createDeps()

      const result = await commitCurrentTaskTool(undefined, deps)

      expect(result.status).toBe('not_found')
      expect(result.message).toBe('Task not found')
    })
  })

  describe('参数处理', () => {
    test('应始终传递 undefined 参数', async () => {
      const deps = createDeps()

      await commitCurrentTaskTool(undefined, deps)

      expect(commitCurrentTaskCalls).toBe(1)
    })

    test('忽略任何传入的参数', async () => {
      const deps = createDeps()

      // @ts-expect-error - Testing with unexpected parameter
      await commitCurrentTaskTool({ unexpected: 'param' }, deps)

      expect(commitCurrentTaskCalls).toBe(1)
    })
  })

  describe('连续调用', () => {
    test('连续调用应每次都调用底层函数', async () => {
      const deps = createDeps()

      await commitCurrentTaskTool(undefined, deps)
      await commitCurrentTaskTool(undefined, deps)
      await commitCurrentTaskTool(undefined, deps)

      expect(commitCurrentTaskCalls).toBe(3)
    })

    test('连续调用应返回各自的结果', async () => {
      let callCount = 0
      const deps = {
        commitCurrentTask: async () => {
          callCount++
          return {
            status: 'committed' as const,
            taskId: `task-${callCount}`,
            message: `Commit ${callCount}`,
          }
        },
      }

      const result1 = await commitCurrentTaskTool(undefined, deps)
      const result2 = await commitCurrentTaskTool(undefined, deps)
      const result3 = await commitCurrentTaskTool(undefined, deps)

      expect(result1.taskId).toBe('task-1')
      expect(result2.taskId).toBe('task-2')
      expect(result3.taskId).toBe('task-3')
    })
  })

  describe('错误处理', () => {
    test('底层函数抛出错误时应向上传播', async () => {
      const deps = {
        commitCurrentTask: async () => {
          throw new Error('Commit service unavailable')
        },
      }

      await expect(commitCurrentTaskTool(undefined, deps)).rejects.toThrow(
        'Commit service unavailable',
      )
    })

    test('底层函数返回非标准结果时应正常传递', async () => {
      const customResult = {
        status: 'committed',
        taskId: 'task-1',
        message: 'Success',
        customField: 'custom value',
        extraData: { key: 'value' },
      } as CommitTaskResult
      const deps = {
        commitCurrentTask: async () => customResult,
      }

      const result = await commitCurrentTaskTool(undefined, deps)

      expect(result).toEqual(customResult)
    })
  })

  describe('返回值验证', () => {
    test('返回值应包含 status 字段', async () => {
      const deps = createDeps()

      const result = await commitCurrentTaskTool(undefined, deps)

      expect(result).toHaveProperty('status')
    })

    test('返回值应包含 message 字段', async () => {
      const deps = createDeps()

      const result = await commitCurrentTaskTool(undefined, deps)

      expect(result).toHaveProperty('message')
    })

    test('status 应该是有效的提交状态', async () => {
      const deps = createDeps()

      const result = await commitCurrentTaskTool(undefined, deps)

      expect(['committed', 'noop', 'failed', 'not_found']).toContain(result.status)
    })
  })
})
