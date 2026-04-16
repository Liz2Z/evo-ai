import { beforeEach, describe, expect, test } from 'bun:test'
import { completeMissionTool } from '../../../src/manager/tools/complete-mission'
import type { CompleteMissionResult } from '../../../src/manager/runtime'

describe('completeMissionTool 工具函数', () => {
  let mockCompleteResult: CompleteMissionResult | null
  let completeMissionCalls: number

  beforeEach(() => {
    mockCompleteResult = null
    completeMissionCalls = 0
  })

  function createDeps() {
    return {
      completeMission: async () => {
        completeMissionCalls++
        return (
          mockCompleteResult ?? {
            status: 'merged',
            message: 'Mission completed and merged',
          }
        )
      },
    }
  }

  describe('基本功能', () => {
    test('应调用 completeMission 并返回结果', async () => {
      mockCompleteResult = {
        status: 'merged',
        message: 'Mission successfully completed',
      }
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result).toEqual(mockCompleteResult)
      expect(completeMissionCalls).toBe(1)
    })

    test('应传递所有返回字段', async () => {
      mockCompleteResult = {
        status: 'merged',
        message: 'All tasks completed, mission branch merged',
        mergeCommitHash: 'def456',
        branchDeleted: true,
      }
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result.status).toBe('merged')
      expect(result.message).toBe('All tasks completed, mission branch merged')
      expect(result.mergeCommitHash).toBe('def456')
      expect(result.branchDeleted).toBe(true)
    })
  })

  describe('边界条件', () => {
    test('noop 状态应正确返回', async () => {
      mockCompleteResult = {
        status: 'noop',
        message: 'Mission has pending tasks, cannot complete',
      }
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result.status).toBe('noop')
      expect(result.message).toContain('pending tasks')
    })

    test('failed 状态应正确返回', async () => {
      mockCompleteResult = {
        status: 'failed',
        message: 'Failed to merge mission branch',
      }
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result.status).toBe('failed')
      expect(result.message).toContain('Failed to merge')
    })

    test('空消息应正常处理', async () => {
      mockCompleteResult = {
        status: 'merged',
        message: '',
      }
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result.status).toBe('merged')
      expect(result.message).toBe('')
    })
  })

  describe('参数处理', () => {
    test('应始终传递 undefined 参数', async () => {
      const deps = createDeps()

      await completeMissionTool(undefined, deps)

      expect(completeMissionCalls).toBe(1)
    })

    test('忽略任何传入的参数', async () => {
      const deps = createDeps()

      // @ts-expect-error - Testing with unexpected parameter
      await completeMissionTool({ unexpected: 'param' }, deps)

      expect(completeMissionCalls).toBe(1)
    })

    test('忽略 null 参数', async () => {
      const deps = createDeps()

      // @ts-expect-error - Testing with null parameter
      await completeMissionTool(null, deps)

      expect(completeMissionCalls).toBe(1)
    })
  })

  describe('连续调用', () => {
    test('连续调用应每次都调用底层函数', async () => {
      const deps = createDeps()

      await completeMissionTool(undefined, deps)
      await completeMissionTool(undefined, deps)
      await completeMissionTool(undefined, deps)

      expect(completeMissionCalls).toBe(3)
    })

    test('连续调用应返回各自的结果', async () => {
      let callCount = 0
      const deps = {
        completeMission: async () => {
          callCount++
          return {
            status: 'merged' as const,
            message: `Mission completed ${callCount} times`,
          }
        },
      }

      const result1 = await completeMissionTool(undefined, deps)
      const result2 = await completeMissionTool(undefined, deps)
      const result3 = await completeMissionTool(undefined, deps)

      expect(result1.message).toBe('Mission completed 1 times')
      expect(result2.message).toBe('Mission completed 2 times')
      expect(result3.message).toBe('Mission completed 3 times')
    })

    test('第一次成功后第二次调用应返回 noop', async () => {
      let callCount = 0
      const deps = {
        completeMission: async () => {
          callCount++
          if (callCount === 1) {
            return { status: 'merged' as const, message: 'First success' }
          }
          return { status: 'noop' as const, message: 'Already completed' }
        },
      }

      const result1 = await completeMissionTool(undefined, deps)
      const result2 = await completeMissionTool(undefined, deps)

      expect(result1.status).toBe('merged')
      expect(result2.status).toBe('noop')
    })
  })

  describe('错误处理', () => {
    test('底层函数抛出错误时应向上传播', async () => {
      const deps = {
        completeMission: async () => {
          throw new Error('Mission service unavailable')
        },
      }

      await expect(completeMissionTool(undefined, deps)).rejects.toThrow(
        'Mission service unavailable',
      )
    })

    test('底层函数抛出非 Error 对象时应正常传播', async () => {
      const deps = {
        completeMission: async () => {
          throw 'String error'
        },
      }

      await expect(completeMissionTool(undefined, deps)).rejects.toThrow('String error')
    })

    test('底层函数返回非标准结果时应正常传递', async () => {
      const customResult = {
        status: 'merged',
        message: 'Success',
        customField: 'custom value',
        extraData: { completedAt: new Date().toISOString() },
      } as CompleteMissionResult
      const deps = {
        completeMission: async () => customResult,
      }

      const result = await completeMissionTool(undefined, deps)

      expect(result).toEqual(customResult)
    })
  })

  describe('返回值验证', () => {
    test('返回值应包含 status 字段', async () => {
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result).toHaveProperty('status')
    })

    test('返回值应包含 message 字段', async () => {
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result).toHaveProperty('message')
    })

    test('status 应该是有效的完成状态', async () => {
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(['merged', 'noop', 'failed']).toContain(result.status)
    })
  })

  describe('状态场景', () => {
    test('有 pending 任务时返回 noop', async () => {
      mockCompleteResult = {
        status: 'noop',
        message: 'Cannot complete: 3 pending tasks remaining',
      }
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result.status).toBe('noop')
    })

    test('有 failed 任务时仍允许完成', async () => {
      mockCompleteResult = {
        status: 'merged',
        message: 'Mission completed with 1 failed task',
      }
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result.status).toBe('merged')
    })

    test('所有任务完成时允许完成', async () => {
      mockCompleteResult = {
        status: 'merged',
        message: 'All tasks completed successfully',
      }
      const deps = createDeps()

      const result = await completeMissionTool(undefined, deps)

      expect(result.status).toBe('merged')
    })
  })
})
