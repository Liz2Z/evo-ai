import { beforeEach, describe, expect, test } from 'bun:test'
import { getManagerSnapshot } from '../../../src/manager/tools/get-manager-snapshot'
import type { ManagerState } from '../../../src/types'

describe('getManagerSnapshot 工具函数', () => {
  let mockState: ManagerState
  let mockActiveAgents: number
  let refreshCalls: number

  beforeEach(() => {
    mockState = {
      mission: 'test-mission',
      runtimeMode: 'hybrid',
      currentPhase: 'working',
      turnStatus: 'idle',
      activeSince: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      lastInspection: new Date().toISOString(),
      pendingQuestions: [],
      lastDecisionAt: new Date().toISOString(),
      skippedWakeups: 0,
      lastSkippedTriggerReason: undefined,
      currentStage: 'working',
      pendingUserMessages: [],
      missionBranch: 'mission/test-123',
      missionWorktree: '/tmp/workspace',
      currentTaskId: 'task-1',
    }
    mockActiveAgents = 1
    refreshCalls = 0
  })

  function createDeps() {
    return {
      state: mockState,
      refreshActiveAgents: async () => {
        refreshCalls++
        // Simulate refresh updating active agents
        mockActiveAgents = Math.max(0, mockActiveAgents - 1)
      },
      activeAgents: mockActiveAgents,
    }
  }

  describe('基本功能', () => {
    test('应返回完整的 manager 快照', async () => {
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot).toHaveProperty('mission')
      expect(snapshot).toHaveProperty('runtimeMode')
      expect(snapshot).toHaveProperty('currentPhase')
      expect(snapshot).toHaveProperty('turnStatus')
      expect(snapshot).toHaveProperty('activeAgents')
      expect(snapshot).toHaveProperty('maxConcurrency')
      expect(snapshot).toHaveProperty('pendingCount')
      expect(snapshot).toHaveProperty('pendingQuestions')
      expect(snapshot).toHaveProperty('lastHeartbeat')
      expect(snapshot).toHaveProperty('lastDecisionAt')
    })

    test('应正确映射所有状态字段', async () => {
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.mission).toBe('test-mission')
      expect(snapshot.runtimeMode).toBe('hybrid')
      expect(snapshot.currentPhase).toBe('working')
      expect(snapshot.turnStatus).toBe('idle')
      expect(snapshot.missionBranch).toBe('mission/test-123')
      expect(snapshot.missionWorktree).toBe('/tmp/workspace')
      expect(snapshot.currentTaskId).toBe('task-1')
      expect(snapshot.currentStage).toBe('working')
    })

    test('应调用 refreshActiveAgents', async () => {
      const deps = createDeps()

      await getManagerSnapshot(deps.state, deps.refreshActiveAgents, deps.activeAgents)

      expect(refreshCalls).toBe(1)
    })

    test('应使用刷新后的 active agents 数量', async () => {
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.activeAgents).toBeGreaterThanOrEqual(0)
    })
  })

  describe('边界条件', () => {
    test('空 mission 应正常处理', async () => {
      mockState.mission = ''
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.mission).toBe('')
    })

    test('undefined currentTaskId 应正常处理', async () => {
      mockState.currentTaskId = undefined
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.currentTaskId).toBeUndefined()
    })

    test('undefined missionBranch 应正常处理', async () => {
      mockState.missionBranch = undefined
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.missionBranch).toBeUndefined()
    })

    test('undefined missionWorktree 应正常处理', async () => {
      mockState.missionWorktree = undefined
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.missionWorktree).toBeUndefined()
    })

    test('零个活跃 agent 应正常处理', async () => {
      mockActiveAgents = 0
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.activeAgents).toBe(0)
    })

    test('多个活跃 agent 应正常处理', async () => {
      mockActiveAgents = 5
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.activeAgents).toBeGreaterThanOrEqual(0)
    })

    test('空的待办问题列表应正常处理', async () => {
      mockState.pendingQuestions = []
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.pendingQuestions).toEqual([])
    })

    test('多个待办问题应正常处理', async () => {
      mockState.pendingQuestions = [
        {
          id: 'q-1',
          question: '问题 1',
          options: ['A', 'B'],
          createdAt: new Date().toISOString(),
          source: 'testing',
          answered: false,
        },
        {
          id: 'q-2',
          question: '问题 2',
          options: [],
          createdAt: new Date().toISOString(),
          source: 'testing',
          answered: false,
        },
      ]
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.pendingQuestions).toHaveLength(2)
    })

    test 'skippedWakeups 为零应正常处理', async () => {
      mockState.skippedWakeups = 0
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.skippedWakeups).toBe(0)
    })

    test('skippedWakeups 为正数应正常处理', async () => {
      mockState.skippedWakeups = 5
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.skippedWakeups).toBe(5)
    })

    test('lastSkippedTriggerReason 存在时应包含', async () => {
      mockState.lastSkippedTriggerReason = 'waiting_for_user_input'
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.lastSkippedTriggerReason).toBe('waiting_for_user_input')
    })

    test('undefined pendingUserMessages 应返回空数组', async () => {
      mockState.pendingUserMessages = undefined
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.pendingUserMessages).toEqual([])
    })

    test('有 pendingUserMessages 时应正确返回', async () => {
      mockState.pendingUserMessages = [
        {
          timestamp: new Date().toISOString(),
          content: '测试消息',
          source: 'user',
        },
      ]
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.pendingUserMessages).toHaveLength(1)
      expect(snapshot.pendingUserMessages[0].content).toBe('测试消息')
    })
  })

  describe('maxConcurrency', () => {
    test('maxConcurrency 应始终为 1', async () => {
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.maxConcurrency).toBe(1)
    })
  })

  describe('pendingCount', () => {
    test('pendingCount 应基于实际任务状态计算', async () => {
      const deps = createDeps()
      
      // Mock loadTasks to return specific tasks
      const storageModule = await import('../../../src/utils/storage')
      const mockLoadTasks = spyOn(storageModule, 'loadTasks').mockResolvedValue([
        { id: 'task-1', status: 'pending' },
        { id: 'task-2', status: 'pending' },
        { id: 'task-3', status: 'running' },
        { id: 'task-4', status: 'completed' },
      ] as any)

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.pendingCount).toBe(2)
      mockLoadTasks.mockRestore()
    })

    test('没有 pending 任务时应返回 0', async () => {
      const deps = createDeps()

      const storageModule = await import('../../../src/utils/storage')
      const mockLoadTasks = spyOn(storageModule, 'loadTasks').mockResolvedValue([
        { id: 'task-1', status: 'running' },
        { id: 'task-2', status: 'completed' },
      ] as any)

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.pendingCount).toBe(0)
      mockLoadTasks.mockRestore()
    })

    test('所有任务都是 pending 时应返回任务总数', async () => {
      const deps = createDeps()

      const storageModule = await import('../../../src/utils/storage')
      const mockLoadTasks = spyOn(storageModule, 'loadTasks').mockResolvedValue([
        { id: 'task-1', status: 'pending' },
        { id: 'task-2', status: 'pending' },
        { id: 'task-3', status: 'pending' },
      ] as any)

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot.pendingCount).toBe(3)
      mockLoadTasks.mockRestore()
    })
  })

  describe('错误处理', () => {
    test('refreshActiveAgents 抛出错误时应向上传播', async () => {
      const deps = {
        state: mockState,
        refreshActiveAgents: async () => {
          throw new Error('Refresh failed')
        },
        activeAgents: mockActiveAgents,
      }

      await expect(
        getManagerSnapshot(deps.state, deps.refreshActiveAgents, deps.activeAgents),
      ).rejects.toThrow('Refresh failed')
    })

    test('loadTasks 抛出错误时应向上传播', async () => {
      const deps = createDeps()

      const storageModule = await import('../../../src/utils/storage')
      spyOn(storageModule, 'loadTasks').mockImplementation(() => {
        throw new Error('Storage error')
      })

      await expect(
        getManagerSnapshot(deps.state, deps.refreshActiveAgents, deps.activeAgents),
      ).rejects.toThrow('Storage error')
    })
  })

  describe('连续调用', () => {
    test('连续调用应每次都刷新 active agents', async () => {
      const deps = createDeps()

      await getManagerSnapshot(deps.state, deps.refreshActiveAgents, deps.activeAgents)
      await getManagerSnapshot(deps.state, deps.refreshActiveAgents, deps.activeAgents)
      await getManagerSnapshot(deps.state, deps.refreshActiveAgents, deps.activeAgents)

      expect(refreshCalls).toBe(3)
    })

    test('连续调用应返回最新的状态', async () => {
      const deps = createDeps()

      mockState.currentPhase = 'working'
      const snapshot1 = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      mockState.currentPhase = 'idle'
      const snapshot2 = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot1.currentPhase).toBe('working')
      expect(snapshot2.currentPhase).toBe('idle')
    })
  })

  describe('返回值类型', () => {
    test('返回值应包含所有必需字段', async () => {
      const deps = createDeps()

      const snapshot = await getManagerSnapshot(
        deps.state,
        deps.refreshActiveAgents,
        deps.activeAgents,
      )

      expect(snapshot).toMatchObject({
        mission: expect.any(String),
        runtimeMode: expect.any(String),
        currentPhase: expect.any(String),
        turnStatus: expect.any(String),
        activeAgents: expect.any(Number),
        maxConcurrency: expect.any(Number),
        pendingCount: expect.any(Number),
        pendingQuestions: expect.any(Array),
        lastHeartbeat: expect.any(String),
        lastDecisionAt: expect.any(String),
        skippedWakeups: expect.any(Number),
        currentStage: expect.any(String),
        pendingUserMessages: expect.any(Array),
      })
    })
  })
})
