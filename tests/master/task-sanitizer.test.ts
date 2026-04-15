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
    context: 'Mission link: 这是当前 mission 的直接下一步。Scope: src/master/scheduler.ts',
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

  test('过滤缺少关联说明的任务', () => {
    const task = createTask('n1', 'Refactor status bar rendering logic')
    delete task.context

    const result = sanitizeInspectorTasks([task], [])
    expect(result.accepted).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('missing_relevance')
  })

  test('允许带 follow-up 说明的任务', () => {
    const task = createTask('n1', 'Add focused regression tests for the new mission flow')
    task.context =
      'Follow-up value: hardens the newly completed mission path. Scope: tests/master/runtime-driver.test.ts'

    const result = sanitizeInspectorTasks([task], [])
    expect(result.accepted.map((item) => item.id)).toEqual(['n1'])
    expect(result.dropped).toHaveLength(0)
  })

  test('最多保留 3 个最高优先级任务', () => {
    const incoming = [
      { ...createTask('n1', 'Task 1'), priority: 1 },
      { ...createTask('n2', 'Task 2'), priority: 8 },
      { ...createTask('n3', 'Task 3'), priority: 6 },
      { ...createTask('n4', 'Task 4'), priority: 10 },
    ]

    const result = sanitizeInspectorTasks(incoming, [])
    expect(result.accepted.map((task) => task.id)).toEqual(['n4', 'n2', 'n3'])
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('over_limit')
  })
})
