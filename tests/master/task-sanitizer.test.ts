import { describe, expect, test } from 'bun:test'
import { sanitizeInspectorTasks } from '../../src/master/task-sanitizer'
import type { Task } from '../../src/types'

function createTask(id: string, description: string, status: Task['status'] = 'pending'): Task {
  const now = new Date().toISOString()
  return {
    id,
    type: 'other',
    status,
    priority: 5,
    description,
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    maxAttempts: 3,
    reviewHistory: [],
  }
}

describe('sanitizeInspectorTasks', () => {
  test('过滤低价值注释任务', () => {
    const incoming = [
      createTask(
        't1',
        'Add a comment "// Auto-generated" at the top of any .ts file in the project.',
      ),
    ]

    const result = sanitizeInspectorTasks(incoming, [])
    expect(result.accepted).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('low_value')
  })

  test('过滤与现有活跃任务重复的任务', () => {
    const existing = [
      createTask('e1', 'Fix race condition in scheduler turn serialization', 'running'),
    ]
    const incoming = [createTask('n1', 'Fix race condition in scheduler turn serialization')]

    const result = sanitizeInspectorTasks(incoming, existing)
    expect(result.accepted).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('duplicate')
  })

  test('过滤 inspector 同批次重复任务', () => {
    const incoming = [
      createTask('n1', 'Add tests for scheduler recovery logic'),
      createTask('n2', 'Add tests for scheduler recovery logic'),
    ]

    const result = sanitizeInspectorTasks(incoming, [])
    expect(result.accepted).toHaveLength(1)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('duplicate')
  })

  test('保留正常高价值任务', () => {
    const incoming = [
      createTask('n1', 'Fix missing error handling in merge conflict cleanup path'),
      createTask('n2', 'Add unit tests for storage event projection updates'),
    ]

    const result = sanitizeInspectorTasks(incoming, [])
    expect(result.accepted.map((task) => task.id)).toEqual(['n1', 'n2'])
    expect(result.dropped).toHaveLength(0)
  })
})
