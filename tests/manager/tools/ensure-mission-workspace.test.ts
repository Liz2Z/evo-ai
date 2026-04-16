import { beforeEach, describe, expect, test } from 'bun:test'
import { ensureMissionWorkspace } from '../../../src/manager/tools/ensure-mission-workspace'
import type { MissionWorkspaceResult } from '../../../src/manager/runtime'

describe('ensureMissionWorkspace 工具函数', () => {
  let mockEnsureResult: MissionWorkspaceResult | null
  let ensureCalls: number

  beforeEach(() => {
    mockEnsureResult = null
    ensureCalls = 0
  })

  function createDeps() {
    return {
      ensureMissionWorkspaceReady: async (): Promise<MissionWorkspaceResult> => {
        ensureCalls++
        return (
          mockEnsureResult ?? {
            status: 'ready',
            path: '/tmp/test-workspace',
            branch: 'mission/test-123',
            message: 'Workspace ready',
          }
        )
      },
    }
  }

  describe('基本功能', () => {
    test('应调用 ensureMissionWorkspaceReady 并返回结果', async () => {
      mockEnsureResult = {
        status: 'ready',
        path: '/tmp/workspace',
        branch: 'mission/abc',
        message: 'Workspace is ready',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result).toEqual(mockEnsureResult)
      expect(ensureCalls).toBe(1)
    })

    test('应正确传递所有返回字段', async () => {
      mockEnsureResult = {
        status: 'ready',
        path: '/custom/path/to/workspace',
        branch: 'mission/custom-branch',
        message: 'Custom workspace created',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.status).toBe('ready')
      expect(result.path).toBe('/custom/path/to/workspace')
      expect(result.branch).toBe('mission/custom-branch')
      expect(result.message).toBe('Custom workspace created')
    })
  })

  describe('边界条件', () => {
    test('failed 状态应正确返回', async () => {
      mockEnsureResult = {
        status: 'failed',
        message: 'Failed to create workspace: disk full',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.status).toBe('failed')
      expect(result.message).toContain('disk full')
      expect(result.path).toBeUndefined()
      expect(result.branch).toBeUndefined()
    })

    test('ready 状态但无路径应正常处理', async () => {
      mockEnsureResult = {
        status: 'ready',
        message: 'Workspace ready but path not set',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.status).toBe('ready')
      expect(result.path).toBeUndefined()
    })

    test('空消息应正常处理', async () => {
      mockEnsureResult = {
        status: 'ready',
        path: '/tmp/workspace',
        branch: 'mission/test',
        message: '',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.message).toBe('')
    })

    test('路径包含特殊字符应正常处理', async () => {
      mockEnsureResult = {
        status: 'ready',
        path: '/tmp/workspace with spaces/路径',
        branch: 'mission/test',
        message: 'Path with special chars',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.path).toBe('/tmp/workspace with spaces/路径')
    })

    test('分支名包含特殊字符应正常处理', async () => {
      mockEnsureResult = {
        status: 'ready',
        path: '/tmp/workspace',
        branch: 'mission/feature/test-123',
        message: 'Branch with slashes',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.branch).toBe('mission/feature/test-123')
    })
  })

  describe('连续调用', () => {
    test('连续调用应每次都调用底层函数', async () => {
      const deps = createDeps()

      await ensureMissionWorkspace(deps)
      await ensureMissionWorkspace(deps)
      await ensureMissionWorkspace(deps)

      expect(ensureCalls).toBe(3)
    })

    test('连续调用应返回各自的结果', async () => {
      let callCount = 0
      const deps = {
        ensureMissionWorkspaceReady: async (): Promise<MissionWorkspaceResult> => {
          callCount++
          return {
            status: 'ready',
            path: `/tmp/workspace-${callCount}`,
            branch: `mission/test-${callCount}`,
            message: `Call ${callCount}`,
          }
        },
      }

      const result1 = await ensureMissionWorkspace(deps)
      const result2 = await ensureMissionWorkspace(deps)
      const result3 = await ensureMissionWorkspace(deps)

      expect(result1.path).toBe('/tmp/workspace-1')
      expect(result2.path).toBe('/tmp/workspace-2')
      expect(result3.path).toBe('/tmp/workspace-3')
    })

    test('第一次成功后第二次调用应返回相同结果（幂等）', async () => {
      const expectedResult = {
        status: 'ready' as const,
        path: '/tmp/workspace',
        branch: 'mission/test',
        message: 'Workspace ready',
      }
      const deps = {
        ensureMissionWorkspaceReady: async () => expectedResult,
      }

      const result1 = await ensureMissionWorkspace(deps)
      const result2 = await ensureMissionWorkspace(deps)

      expect(result1).toEqual(expectedResult)
      expect(result2).toEqual(expectedResult)
    })
  })

  describe('错误处理', () => {
    test('底层函数抛出错误时应向上传播', async () => {
      const deps = {
        ensureMissionWorkspaceReady: async () => {
          throw new Error('Git repository not found')
        },
      }

      await expect(ensureMissionWorkspace(deps)).rejects.toThrow('Git repository not found')
    })

    test('底层函数抛出非 Error 对象时应正常传播', async () => {
      const deps = {
        ensureMissionWorkspaceReady: async () => {
          throw 'String error message'
        },
      }

      await expect(ensureMissionWorkspace(deps)).rejects.toThrow('String error message')
    })

    test('底层函数抛出数字错误时应正常传播', async () => {
      const deps = {
        ensureMissionWorkspaceReady: async () => {
          throw 404
        },
      }

      // toThrow 需要字符串或 Error 对象，数字会被转换为字符串
      await expect(ensureMissionWorkspace(deps)).rejects.toThrow()
    })
  })

  describe('返回值验证', () => {
    test('返回值应包含 status 字段', async () => {
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result).toHaveProperty('status')
    })

    test('返回值应包含 message 字段', async () => {
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result).toHaveProperty('message')
    })

    test('status 应该是有效的工作空间状态', async () => {
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(['ready', 'failed']).toContain(result.status)
    })

    test('ready 状态时可以包含 path 和 branch', async () => {
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      if (result.status === 'ready') {
        expect((result.path || result.branch) !== undefined).toBe(true)
      }
    })

    test('failed 状态时不应包含 path 和 branch', async () => {
      mockEnsureResult = {
        status: 'failed',
        message: 'Failed',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      if (result.status === 'failed') {
        expect(result.path).toBeUndefined()
        expect(result.branch).toBeUndefined()
      }
    })
  })

  describe('参数处理', () => {
    test('应正确传递 deps 对象', async () => {
      const deps = createDeps()

      await ensureMissionWorkspace(deps)

      expect(ensureCalls).toBe(1)
    })

    test('deps 中必须包含 ensureMissionWorkspaceReady 函数', async () => {
      const deps = {
        ensureMissionWorkspaceReady: async () => ({
          status: 'ready',
          path: '/tmp',
          branch: 'main',
          message: 'OK',
        }),
      }

      const result = await ensureMissionWorkspace(deps)

      expect(result.status).toBe('ready')
    })
  })

  describe('状态场景', () => {
    test('首次创建应返回 ready', async () => {
      mockEnsureResult = {
        status: 'ready',
        path: '/tmp/new-workspace',
        branch: 'mission/new',
        message: 'Created new workspace',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.status).toBe('ready')
    })

    test('已存在的 workspace 应返回 ready', async () => {
      mockEnsureResult = {
        status: 'ready',
        path: '/tmp/existing-workspace',
        branch: 'mission/existing',
        message: 'Workspace already exists',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.status).toBe('ready')
    })

    test('workspace 损坏时应返回 failed', async () => {
      mockEnsureResult = {
        status: 'failed',
        message: 'Workspace is corrupted',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.status).toBe('failed')
    })

    test('权限不足时应返回 failed', async () => {
      mockEnsureResult = {
        status: 'failed',
        message: 'Permission denied to create workspace',
      }
      const deps = createDeps()

      const result = await ensureMissionWorkspace(deps)

      expect(result.status).toBe('failed')
    })
  })
})
