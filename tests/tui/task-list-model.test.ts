import { describe, expect, test } from 'bun:test'
import { getGroupedTaskIds } from '../../src/tui/components/taskListModel'
import type { Task } from '../../src/types'

function createTask(id: string, status: Task['status']): Task {
  const now = new Date().toISOString()
  return {
    id,
    type: 'other',
    status,
    priority: 1,
    description: `task ${id}`,
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    maxAttempts: 3,
    reviewHistory: [],
  }
}

describe('taskListModel', () => {
  test('导航顺序应与分组渲染顺序一致，而不是原始 tasks 顺序', () => {
    const tasks: Task[] = [
      createTask('1', 'running'),
      createTask('7', 'pending'),
      createTask('2', 'running'),
      createTask('8', 'pending'),
      createTask('3', 'running'),
      createTask('9', 'pending'),
      createTask('4', 'running'),
    ]

    expect(getGroupedTaskIds(tasks)).toEqual(['1', '2', '3', '4', '7', '8', '9'])
  })

  test('assigned 应并入 running 组导航', () => {
    const tasks: Task[] = [
      createTask('1', 'pending'),
      createTask('2', 'assigned'),
      createTask('3', 'running'),
      createTask('4', 'reviewing'),
    ]

    expect(getGroupedTaskIds(tasks)).toEqual(['2', '3', '4', '1'])
  })
})
