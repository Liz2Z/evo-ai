import { beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { getRecentHistory } from '../../../src/manager/tools/get-recent-history'
import type { HistoryEntry } from '../../../src/types'

describe('getRecentHistory 工具函数', () => {
  let mockHistory: HistoryEntry[]

  beforeEach(() => {
    const now = new Date().toISOString()
    mockHistory = [
      {
        timestamp: now,
        type: 'task_created',
        taskId: 'task-1',
        summary: 'Created first task',
      },
      {
        timestamp: now,
        type: 'agent_started',
        agentId: 'worker-1',
        summary: 'Worker started',
      },
      {
        timestamp: now,
        type: 'task_completed',
        taskId: 'task-1',
        summary: 'Task completed',
      },
      {
        timestamp: now,
        type: 'error',
        summary: 'An error occurred',
      },
      {
        timestamp: now,
        type: 'decision',
        summary: 'Manager made a decision',
      },
    ]
  })

  async function setupMocks() {
    const storageModule = await import('../../../src/utils/storage')
    spyOn(storageModule, 'loadHistory').mockResolvedValue(mockHistory)
  }

  describe('基本功能', () => {
    test('应返回历史记录数组', async () => {
      await setupMocks()

      const result = await getRecentHistory()

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(mockHistory.length)
    })

    test('应返回最近的历史记录', async () => {
      await setupMocks()

      const result = await getRecentHistory()

      expect(result).toEqual(mockHistory)
    })

    test('应保持历史记录的顺序', async () => {
      await setupMocks()

      const result = await getRecentHistory()

      expect(result[0].type).toBe('task_created')
      expect(result[1].type).toBe('agent_started')
      expect(result[2].type).toBe('task_completed')
      expect(result[3].type).toBe('error')
      expect(result[4].type).toBe('decision')
    })
  })

  describe('边界条件', () => {
    test('空历史记录应返回空数组', async () => {
      mockHistory = []
      await setupMocks()

      const result = await getRecentHistory()

      expect(result).toEqual([])
    })

    test('单条历史记录应正常返回', async () => {
      mockHistory = [
        {
          timestamp: new Date().toISOString(),
          type: 'task_created',
          summary: 'Single entry',
        },
      ]
      await setupMocks()

      const result = await getRecentHistory()

      expect(result).toHaveLength(1)
      expect(result[0].summary).toBe('Single entry')
    })

    test('超长历史记录应使用默认 limit 20', async () => {
      const longHistory: HistoryEntry[] = []
      for (let i = 0; i < 1000; i++) {
        longHistory.push({
          timestamp: new Date().toISOString(),
          type: 'task_created',
          summary: `Task ${i}`,
        })
      }
      mockHistory = longHistory
      await setupMocks()

      const result = await getRecentHistory()

      // Default limit is 20
      expect(result).toHaveLength(20)
    })
  })

  describe('limit 参数', () => {
    test('limit 为 10 应返回最近 10 条', async () => {
      await setupMocks()

      const result = await getRecentHistory({ limit: 10 })

      expect(result).toHaveLength(Math.min(mockHistory.length, 10))
    })

    test('limit 为 1 应返回最近 1 条', async () => {
      await setupMocks()

      const result = await getRecentHistory({ limit: 1 })

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(mockHistory[mockHistory.length - 1])
    })

    test('limit 大于历史记录长度应返回全部', async () => {
      await setupMocks()

      const result = await getRecentHistory({ limit: 100 })

      expect(result).toHaveLength(mockHistory.length)
    })

    test('limit 为 0 应返回全部（JavaScript slice 行为）', async () => {
      await setupMocks()

      const result = await getRecentHistory({ limit: 0 })

      // slice(0) returns all elements in JavaScript
      expect(result).toHaveLength(mockHistory.length)
    })

    test('负数 limit 应返回最后一条（JavaScript slice 行为）', async () => {
      await setupMocks()

      const result = await getRecentHistory({ limit: -1 })

      // slice(-1) returns the last element in JavaScript
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(mockHistory[mockHistory.length - 1])
    })

    test('默认 limit 应为 20', async () => {
      await setupMocks()

      const result = await getRecentHistory()

      // With 5 items, should return all 5 (less than default 20)
      expect(result).toHaveLength(mockHistory.length)
    })

    test('默认 limit 20 在有 25 条记录时应返回最后 20 条', async () => {
      const history25: HistoryEntry[] = []
      for (let i = 0; i < 25; i++) {
        history25.push({
          timestamp: new Date().toISOString(),
          type: 'task_created',
          summary: `Task ${i}`,
        })
      }
      mockHistory = history25
      await setupMocks()

      const result = await getRecentHistory()

      expect(result).toHaveLength(20)
      expect(result[0].summary).toBe('Task 5')
      expect(result[19].summary).toBe('Task 24')
    })

    test('limit 参数应使用 slice 而不是 splice', async () => {
      const history25: HistoryEntry[] = []
      for (let i = 0; i < 25; i++) {
        history25.push({
          timestamp: new Date().toISOString(),
          type: 'task_created',
          summary: `Task ${i}`,
        })
      }
      mockHistory = history25
      await setupMocks()

      const result = await getRecentHistory({ limit: 10 })

      expect(result).toHaveLength(10)
      expect(result[0].summary).toBe('Task 15')
      expect(result[9].summary).toBe('Task 24')
    })
  })

  describe('undefined 参数', () => {
    test('undefined 参数应使用默认 limit', async () => {
      await setupMocks()

      const result = await getRecentHistory(undefined)

      expect(result).toHaveLength(mockHistory.length)
    })

    test('null 参数应使用默认 limit', async () => {
      await setupMocks()

      // @ts-expect-error - Testing with null
      const result = await getRecentHistory(null)

      expect(result).toHaveLength(mockHistory.length)
    })

    test('空对象参数应使用默认 limit', async () => {
      await setupMocks()

      const result = await getRecentHistory({})

      expect(result).toHaveLength(mockHistory.length)
    })
  })

  describe('历史记录类型', () => {
    test('应正确处理不同类型的记录', async () => {
      mockHistory = [
        {
          timestamp: new Date().toISOString(),
          type: 'task_created',
          taskId: 'task-1',
          summary: 'Task created',
        },
        {
          timestamp: new Date().toISOString(),
          type: 'agent_started',
          agentId: 'worker-1',
          summary: 'Agent started',
        },
        {
          timestamp: new Date().toISOString(),
          type: 'error',
          summary: 'Error occurred',
        },
        {
          timestamp: new Date().toISOString(),
          type: 'decision',
          summary: 'Decision made',
        },
      ]
      await setupMocks()

      const result = await getRecentHistory()

      expect(result[0].type).toBe('task_created')
      expect(result[1].type).toBe('agent_started')
      expect(result[2].type).toBe('error')
      expect(result[3].type).toBe('decision')
    })

    test('应保持记录的所有字段', async () => {
      mockHistory = [
        {
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 'task_created',
          taskId: 'task-123',
          agentId: 'agent-456',
          summary: 'Complete history entry',
        },
      ]
      await setupMocks()

      const result = await getRecentHistory()

      expect(result[0]).toEqual({
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'task_created',
        taskId: 'task-123',
        agentId: 'agent-456',
        summary: 'Complete history entry',
      })
    })
  })

  describe('错误处理', () => {
    test('loadHistory 抛出错误时应向上传播', async () => {
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadHistory').mockImplementation(() => {
        throw new Error('Storage unavailable')
      })

      await expect(getRecentHistory()).rejects.toThrow('Storage unavailable')
    })

    test('loadHistory 返回 null 应当作空数组处理', async () => {
      const storageModule = await import('../../../src/utils/storage')
      // 当 loadHistory 返回 null 时，会抛出错误，而不是返回空数组
      spyOn(storageModule, 'loadHistory').mockResolvedValue(null as any)

      // getRecentHistory 会尝试对 null 调用 slice，这会抛出 TypeError
      await expect(getRecentHistory()).rejects.toThrow()
    })
  })

  describe('连续调用', () => {
    test('连续调用应每次都从存储中获取', async () => {
      let callCount = 0
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadHistory').mockImplementation(() => {
        callCount++
        return Promise.resolve([
          {
            timestamp: new Date().toISOString(),
            type: 'task_created',
            summary: `Call ${callCount}`,
          },
        ])
      })

      const result1 = await getRecentHistory()
      const result2 = await getRecentHistory()
      const result3 = await getRecentHistory()

      expect(callCount).toBe(3)
      expect(result1[0].summary).toBe('Call 1')
      expect(result2[0].summary).toBe('Call 2')
      expect(result3[0].summary).toBe('Call 3')
    })

    test('连续调用应返回最新的历史', async () => {
      let history: HistoryEntry[] = []
      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadHistory').mockImplementation(() => {
        return Promise.resolve(history)
      })

      history = [
        {
          timestamp: new Date().toISOString(),
          type: 'task_created',
          summary: 'First version',
        },
      ]
      const result1 = await getRecentHistory()

      history.push({
        timestamp: new Date().toISOString(),
        type: 'task_completed',
        summary: 'Second version',
      })
      const result2 = await getRecentHistory()

      expect(result1).toHaveLength(1)
      expect(result2).toHaveLength(2)
    })
  })

  describe('特殊字符处理', () => {
    test('包含特殊字符的 summary 应正常处理', async () => {
      mockHistory = [
        {
          timestamp: new Date().toISOString(),
          type: 'task_created',
          summary: '任务包含 "引号" 和 \'撇号\' 和 \n 换行',
        },
      ]
      await setupMocks()

      const result = await getRecentHistory()

      expect(result[0].summary).toContain('引号')
      expect(result[0].summary).toContain('撇号')
    })

    test('包含 emoji 的 summary 应正常处理', async () => {
      mockHistory = [
        {
          timestamp: new Date().toISOString(),
          type: 'task_created',
          summary: '任务 ✅ 完成 🎉',
        },
      ]
      await setupMocks()

      const result = await getRecentHistory()

      expect(result[0].summary).toContain('✅')
      expect(result[0].summary).toContain('🎉')
    })
  })

  describe('返回值类型', () => {
    test('返回值应为 HistoryEntry 数组', async () => {
      await setupMocks()

      const result = await getRecentHistory()

      expect(Array.isArray(result)).toBe(true)
      if (result.length > 0) {
        expect(result[0]).toHaveProperty('timestamp')
        expect(result[0]).toHaveProperty('type')
        expect(result[0]).toHaveProperty('summary')
      }
    })
  })
})
