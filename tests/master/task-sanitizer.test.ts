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
    const existing = [createTask('e1', '修复调度器 turn 串行化中的竞争条件', 'running')]
    const incoming = [createTask('n1', '修复调度器 turn 串行化中的竞争条件')]

    const result = sanitizeInspectorTasks(incoming, existing)
    expect(result.accepted).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('duplicate')
  })

  test('过滤 inspector 同批次重复任务', () => {
    const incoming = [
      createTask('n1', '补充调度器恢复逻辑测试'),
      createTask('n2', '补充调度器恢复逻辑测试'),
    ]

    const result = sanitizeInspectorTasks(incoming, [])
    expect(result.accepted).toHaveLength(1)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('duplicate')
  })

  test('保留正常高价值任务', () => {
    const incoming = [
      createTask('n1', '修复合并冲突清理路径缺失的错误处理'),
      createTask('n2', '补充存储事件投影更新的单元测试'),
    ]

    const result = sanitizeInspectorTasks(incoming, [])
    expect(result.accepted.map((task) => task.id)).toEqual(['n1', 'n2'])
    expect(result.dropped).toHaveLength(0)
  })

  test('过滤非中文任务描述', () => {
    const incoming = [createTask('n1', 'Refactor status bar rendering logic')]

    const result = sanitizeInspectorTasks(incoming, [])
    expect(result.accepted).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('non_chinese')
  })

  test('过滤缺少关联说明的任务', () => {
    const task = createTask('n1', '重构状态栏渲染逻辑')
    delete task.context

    const result = sanitizeInspectorTasks([task], [])
    expect(result.accepted).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('missing_relevance')
  })

  test('允许带 follow-up 说明的任务', () => {
    const task = createTask('n1', '为新的 mission 流程补充聚焦回归测试')
    task.context =
      '后续价值：加固刚完成的 mission 路径。作用范围：tests/master/runtime-driver.test.ts'

    const result = sanitizeInspectorTasks([task], [])
    expect(result.accepted.map((item) => item.id)).toEqual(['n1'])
    expect(result.dropped).toHaveLength(0)
  })

  test('最多保留 3 个最高优先级任务', () => {
    const incoming = [
      { ...createTask('n1', '任务一：补日志'), priority: 1 },
      { ...createTask('n2', '任务二：补测试'), priority: 8 },
      { ...createTask('n3', '任务三：补错误处理'), priority: 6 },
      { ...createTask('n4', '任务四：修复核心流程'), priority: 10 },
    ]

    const result = sanitizeInspectorTasks(incoming, [])
    expect(result.accepted.map((task) => task.id)).toEqual(['n4', 'n2', 'n3'])
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe('over_limit')
  })
})
