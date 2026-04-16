import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test'
import type { Question } from '../../../src/types'
import { askHuman } from '../../../src/manager/tools/ask-human'

describe('askHuman 工具函数', () => {
  let pendingQuestions: Question[]
  let setStateCalls: Array<Partial<{ pendingQuestions: Question[] }>>
  let addQuestionCalls: Question[]

  beforeEach(() => {
    pendingQuestions = []
    setStateCalls = []
    addQuestionCalls = []
  })

  afterEach(() => {
    // Clean up
  })

  function createDeps() {
    return {
      get state() {
        return {
          pendingQuestions,
          currentPhase: 'testing',
        }
      },
      setState: async (updates: Partial<{ pendingQuestions: Question[] }>) => {
        setStateCalls.push(updates)
        if (updates.pendingQuestions) {
          pendingQuestions = updates.pendingQuestions
        }
      },
    }
  }

  describe('基本功能', () => {
    test('应该成功创建新问题', async () => {
      const deps = createDeps()
      const mockAddQuestion = async (question: Question) => {
        addQuestionCalls.push(question)
      }

      // Mock addQuestion
      const originalModule = await import('../../../src/utils/storage')
      spyOn(originalModule, 'addQuestion').mockImplementation(mockAddQuestion)

      const question = '请确认是否继续'
      const options = ['继续', '取消']

      const result = await askHuman({ question, options }, deps)

      expect(result.question).toBe(question)
      expect(result.options).toEqual(options)
      expect(result.source).toBe('testing')
      expect(result.id).toMatch(/^q-\d+-[a-z0-9]{6}$/)
      expect(result.answered).toBeUndefined()
    })

    test('应该正确添加到 pendingQuestions', async () => {
      const deps = createDeps()

      const question = '是否批准此任务？'
      const options = ['批准', '拒绝']

      await askHuman({ question, options }, deps)

      expect(setStateCalls).toHaveLength(1)
      expect(setStateCalls[0].pendingQuestions).toBeDefined()
      expect(setStateCalls[0]!.pendingQuestions).toHaveLength(1)
    })

    test('应该支持无选项的问题', async () => {
      const deps = createDeps()

      const question = '请提供反馈意见'

      const result = await askHuman({ question }, deps)

      expect(result.question).toBe(question)
      expect(result.options).toEqual([])
    })
  })

  describe('边界条件', () => {
    test('重复问题应返回已存在的问题', async () => {
      const existingQuestion: Question = {
        id: 'q-1-abc123',
        question: '是否继续？',
        options: ['是', '否'],
        createdAt: new Date().toISOString(),
        source: 'testing',
        answered: false,
      }
      pendingQuestions = [existingQuestion]

      const deps = createDeps()

      const result = await askHuman(
        { question: '是否继续？', options: ['是', '否'] },
        deps,
      )

      expect(result).toEqual(existingQuestion)
      expect(setStateCalls).toHaveLength(0)
    })

    test('trim 后相同的问题应视为重复', async () => {
      const existingQuestion: Question = {
        id: 'q-1-abc123',
        question: '是否继续？',
        options: ['是', '否'],
        createdAt: new Date().toISOString(),
        source: 'testing',
        answered: false,
      }
      pendingQuestions = [existingQuestion]

      const deps = createDeps()

      const result = await askHuman({ question: '  是否继续？  ' }, deps)

      expect(result).toEqual(existingQuestion)
    })

    test('已回答的问题不应阻止创建相同内容的新问题', async () => {
      const answeredQuestion: Question = {
        id: 'q-1-abc123',
        question: '是否继续？',
        options: ['是', '否'],
        createdAt: new Date().toISOString(),
        source: 'testing',
        answered: true,
      }
      pendingQuestions = [answeredQuestion]

      const deps = createDeps()

      const result = await askHuman({ question: '是否继续？', options: ['是', '否'] }, deps)

      expect(result.id).not.toBe(answeredQuestion.id)
      expect(result.answered).toBeUndefined()
    })

    test('空字符串问题应正常处理', async () => {
      const deps = createDeps()

      const result = await askHuman({ question: '' }, deps)

      expect(result.question).toBe('')
      expect(result.options).toEqual([])
    })

    test('单字符问题应正常处理', async () => {
      const deps = createDeps()

      const result = await askHuman({ question: '?' }, deps)

      expect(result.question).toBe('?')
    })

    test('超长问题应正常处理', async () => {
      const deps = createDeps()
      const longQuestion = 'Q'.repeat(10000)

      const result = await askHuman({ question: longQuestion }, deps)

      expect(result.question).toBe(longQuestion)
    })

    test('包含特殊字符的问题应正常处理', async () => {
      const deps = createDeps()
      const specialQuestion = '问题包含 "引号" 和 \'撇号\' 和 \n 换行 \t 制表符'

      const result = await askHuman({ question: specialQuestion }, deps)

      expect(result.question).toBe(specialQuestion)
    })

    test('包含 emoji 的问题应正常处理', async () => {
      const deps = createDeps()
      const emojiQuestion = '是否继续 🤔？选项：✅ 是 / ❌ 否'

      const result = await askHuman({ question: emojiQuestion }, deps)

      expect(result.question).toBe(emojiQuestion)
    })

    test('多个选项应正确保存', async () => {
      const deps = createDeps()
      const manyOptions = ['选项1', '选项2', '选项3', '选项4', '选项5', '选项6', '选项7', '选项8']

      const result = await askHuman({ question: '选择一个选项', options: manyOptions }, deps)

      expect(result.options).toEqual(manyOptions)
    })

    test('空选项数组应正常处理', async () => {
      const deps = createDeps()

      const result = await askHuman({ question: '测试', options: [] }, deps)

      expect(result.options).toEqual([])
    })

    test('选项包含特殊字符应正常处理', async () => {
      const deps = createDeps()
      const specialOptions = ['选项A (重要)', '选项B: 备选', '选项C - 最终']

      const result = await askHuman(
        { question: '选择', options: specialOptions },
        deps,
      )

      expect(result.options).toEqual(specialOptions)
    })

    test('连续创建多个问题应正确累积', async () => {
      const deps = createDeps()

      await askHuman({ question: '问题1' }, deps)
      await askHuman({ question: '问题2' }, deps)
      await askHuman({ question: '问题3' }, deps)

      expect(pendingQuestions).toHaveLength(3)
      expect(setStateCalls).toHaveLength(3)
    })
  })

  describe('ID 生成', () => {
    test('每次应生成不同的 ID', async () => {
      const deps = createDeps()

      const result1 = await askHuman({ question: '问题1' }, deps)
      const result2 = await askHuman({ question: '问题2' }, deps)

      expect(result1.id).not.toBe(result2.id)
    })

    test('ID 应包含时间戳', async () => {
      const deps = createDeps()
      const before = Date.now()

      const result = await askHuman({ question: '测试' }, deps)

      const after = Date.now()
      const timestamp = parseInt(result.id.split('-')[1])
      expect(timestamp).toBeGreaterThanOrEqual(before)
      expect(timestamp).toBeLessThanOrEqual(after)
    })

    test('ID 应包含随机部分', async () => {
      const deps = createDeps()

      // 快速创建多个问题，确保随机部分不同
      const results = await Promise.all([
        askHuman({ question: '问题1' }, deps),
        askHuman({ question: '问题2' }, deps),
        askHuman({ question: '问题3' }, deps),
      ])

      const randomParts = results.map((r) => r.id.split('-')[2])
      const uniqueRandomParts = new Set(randomParts)
      // 即使快速创建，随机部分也应该不同（概率上）
      expect(uniqueRandomParts.size).toBeGreaterThan(1)
    })
  })

  describe('时间戳', () => {
    test('应生成有效的 ISO 时间戳', async () => {
      const deps = createDeps()
      const before = new Date().toISOString()

      const result = await askHuman({ question: '测试' }, deps)

      const after = new Date().toISOString()
      expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt)
      expect(result.createdAt >= before && result.createdAt <= after).toBe(true)
    })
  })

  describe('source 字段', () => {
    test('应正确设置 source 为当前阶段', async () => {
      const deps = createDeps()

      const result = await askHuman({ question: '测试' }, deps)

      expect(result.source).toBe('testing')
    })

    test('不同的 currentPhase 应反映在 source 中', async () => {
      let savedState: any = null
      const mockSetState = async (state: any) => {
        savedState = state
      }
      const deps1 = {
        state: { pendingQuestions, currentPhase: 'inspecting' },
        setState: mockSetState,
      }
      const deps2 = {
        state: { pendingQuestions, currentPhase: 'working' },
        setState: mockSetState,
      }

      const result1 = await askHuman({ question: '测试1' }, deps1)
      const result2 = await askHuman({ question: '测试2' }, deps2)

      expect(result1.source).toBe('inspecting')
      expect(result2.source).toBe('working')
    })
  })
})
