import { describe, expect, test } from 'bun:test'
import { AgentLauncher } from '../../src/agents/launcher'
import type { Task } from '../../src/types'

function createTask(id: string): Task {
  return {
    id,
    type: 'other',
    status: 'pending',
    priority: 3,
    description: 'test task',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 3,
    reviewHistory: [],
  }
}

describe('AgentLauncher parsing', () => {
  test('inspector 结果被 markdown 代码块包裹时仍能解析为 JSON 摘要', async () => {
    const launcher = new AgentLauncher({
      type: 'inspector',
      task: createTask('inspection'),
      mission: 'test mission',
      recentDecisions: [],
    })

    const output = [
      '```json',
      '{"tasks":[{"description":"fix parser","type":"fix","priority":7}]}',
      '```',
    ].join('\n')

    const result = await (launcher as any).parseTaskResult(output)
    expect(result.status).toBe('completed')
    expect(result.summary).toContain('"tasks"')
  })

  test('reviewer 输出为 markdown 代码块时仍能提取 verdict', () => {
    const launcher = new AgentLauncher({
      type: 'reviewer',
      task: createTask('review'),
      mission: 'test mission',
      recentDecisions: [],
    })

    const output = [
      '```json',
      '{"verdict":"approve","confidence":0.9,"summary":"looks good","issues":[],"suggestions":[]}',
      '```',
    ].join('\n')

    const result = (launcher as any).parseReviewResult(output)
    expect(result.verdict).toBe('approve')
    expect(result.confidence).toBe(0.9)
    expect(result.summary).toBe('looks good')
  })
})
