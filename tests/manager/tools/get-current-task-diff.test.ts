import { beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { getCurrentTaskDiff } from '../../../src/manager/tools/get-current-task-diff'

describe('getCurrentTaskDiff 工具函数', () => {
  let mockDiff: string
  let mockWorktree: string | undefined

  beforeEach(() => {
    mockDiff = 'diff --git a/test.ts b/test.ts\n+new line'
    mockWorktree = '/tmp/test-workspace'
  })

  async function setupMocks() {
    const gitModule = await import('../../../src/utils/git')
    spyOn(gitModule, 'getUncommittedDiff').mockReturnValue(Promise.resolve(mockDiff))
  }

  describe('基本功能', () => {
    test('应返回 mission worktree 的 diff', async () => {
      await setupMocks()
      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe(mockDiff)
    })

    test('应包含完整的 diff 内容', async () => {
      const fullDiff = `diff --git a/src/test.ts b/src/test.ts
index abc123..def456 100644
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
 old line
+new line
 another old line`
      mockDiff = fullDiff
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe(fullDiff)
      expect(result).toContain('diff --git')
      expect(result).toContain('+new line')
    })
  })

  describe('边界条件', () => {
    test('mission worktree 为 undefined 时应返回空字符串', async () => {
      const result = await getCurrentTaskDiff(undefined)

      expect(result).toBe('')
    })

    test('mission worktree 为空字符串时应返回空字符串', async () => {
      const result = await getCurrentTaskDiff('')

      expect(result).toBe('')
    })

    test('空 diff 应正常返回', async () => {
      mockDiff = ''
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe('')
    })

    test('仅空格的 diff 应正常返回', async () => {
      mockDiff = '   \n\t  '
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe('   \n\t  ')
    })

    test('超长 diff 应正常返回', async () => {
      const longDiff = 'diff --git a/test.ts b/test.ts\n' + '+line'.repeat(10000)
      mockDiff = longDiff
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe(longDiff)
    })

    test('包含特殊字符的 diff 应正常返回', async () => {
      const specialDiff = 'diff --git a/测试.ts b/测试.ts\n+中文内容\n+emoji 🎉'
      mockDiff = specialDiff
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe(specialDiff)
    })

    test('包含二进制文件的 diff 应正常返回', async () => {
      const binaryDiff = 'diff --git a/image.png b/image.png\nBinary files differ'
      mockDiff = binaryDiff
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe(binaryDiff)
    })

    test('多文件 diff 应正常返回', async () => {
      const multiFileDiff = `diff --git a/file1.ts b/file1.ts
+change 1
diff --git a/file2.ts b/file2.ts
+change 2
diff --git a/file3.ts b/file3.ts
+change 3`
      mockDiff = multiFileDiff
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe(multiFileDiff)
      expect(result.split('diff --git').length).toBe(3) // 3 files
    })
  })

  describe('错误处理', () => {
    test('getUncommittedDiff 抛出错误时应向上传播', async () => {
      const gitModule = await import('../../../src/utils/git')
      spyOn(gitModule, 'getUncommittedDiff').mockImplementation(() => {
        throw new Error('Git command failed')
      })

      await expect(getCurrentTaskDiff(mockWorktree)).rejects.toThrow('Git command failed')
    })

    test('worktree 不存在时应抛出错误', async () => {
      const gitModule = await import('../../../src/utils/git')
      spyOn(gitModule, 'getUncommittedDiff').mockImplementation(() => {
        throw new Error("Path doesn't exist")
      })

      await expect(getCurrentTaskDiff('/nonexistent/path')).rejects.toThrow(
        "Path doesn't exist",
      )
    })

    test('非 git 目录应抛出错误', async () => {
      const gitModule = await import('../../../src/utils/git')
      spyOn(gitModule, 'getUncommittedDiff').mockImplementation(() => {
        throw new Error('Not a git repository')
      })

      await expect(getCurrentTaskDiff('/tmp/not-a-repo')).rejects.toThrow(
        'Not a git repository',
      )
    })
  })

  describe('worktree 路径处理', () => {
    test('相对路径应正常处理', async () => {
      mockDiff = 'some diff'
      await setupMocks()

      const result = await getCurrentTaskDiff('./relative/path')

      expect(result).toBe('some diff')
    })

    test('绝对路径应正常处理', async () => {
      mockDiff = 'some diff'
      await setupMocks()

      const result = await getCurrentTaskDiff('/absolute/path/to/worktree')

      expect(result).toBe('some diff')
    })

    test('包含空格的路径应正常处理', async () => {
      mockDiff = 'some diff'
      await setupMocks()

      const result = await getCurrentTaskDiff('/path with spaces/workspace')

      expect(result).toBe('some diff')
    })

    test('包含特殊字符的路径应正常处理', async () => {
      mockDiff = 'some diff'
      await setupMocks()

      const result = await getCurrentTaskDiff('/path/with/特殊/字符')

      expect(result).toBe('some diff')
    })

    test('包含 emoji 的路径应正常处理', async () => {
      mockDiff = 'some diff'
      await setupMocks()

      const result = await getCurrentTaskDiff('/path/with/emoji/🎉')

      expect(result).toBe('some diff')
    })
  })

  describe('返回值类型', () => {
    test('应始终返回字符串', async () => {
      mockDiff = 'diff content'
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(typeof result).toBe('string')
    })

    test('无 worktree 时返回空字符串类型', async () => {
      const result = await getCurrentTaskDiff(undefined)

      expect(typeof result).toBe('string')
      expect(result).toBe('')
    })
  })

  describe('diff 格式', () => {
    test('标准 unified diff 格式应正常返回', async () => {
      const unifiedDiff = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new`
      mockDiff = unifiedDiff
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe(unifiedDiff)
    })

    test('包含上下文的 diff 应正常返回', async () => {
      const contextDiff = `diff --git a/test.ts b/test.ts
@@ -1,3 +1,4 @@
 context line 1
 context line 2
-old line
+new line
 context line 3`
      mockDiff = contextDiff
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe(contextDiff)
    })

    test('包含重命名的 diff 应正常返回', async () => {
      const renameDiff = `diff --git a/old.ts b/new.ts
similarity index 95%
rename from old.ts
rename to new.ts`
      mockDiff = renameDiff
      await setupMocks()

      const result = await getCurrentTaskDiff(mockWorktree)

      expect(result).toBe(renameDiff)
    })
  })

  describe('连续调用', () => {
    test('连续调用应每次都获取最新 diff', async () => {
      let callCount = 0
      const gitModule = await import('../../../src/utils/git')
      spyOn(gitModule, 'getUncommittedDiff').mockImplementation(() => {
        callCount++
        return Promise.resolve(`diff content ${callCount}`)
      })

      const result1 = await getCurrentTaskDiff(mockWorktree)
      const result2 = await getCurrentTaskDiff(mockWorktree)
      const result3 = await getCurrentTaskDiff(mockWorktree)

      expect(result1).toBe('diff content 1')
      expect(result2).toBe('diff content 2')
      expect(result3).toBe('diff content 3')
    })
  })
})
