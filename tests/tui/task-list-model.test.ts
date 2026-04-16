import { describe, expect, test } from 'bun:test'
import { getAdjacentGroupTaskId, getGroupedTaskIds } from '../../src/tui/components/taskListModel'
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

  test('reviewing 应位于 pending 之前', () => {
    const tasks: Task[] = [
      createTask('1', 'pending'),
      createTask('2', 'running'),
      createTask('3', 'reviewing'),
      createTask('4', 'completed'),
    ]

    expect(getGroupedTaskIds(tasks)).toEqual(['2', '3', '1', '4'])
  })

  test('向右应跳到下一个非空阶段的首个任务', () => {
    const tasks: Task[] = [
      createTask('run-1', 'running'),
      createTask('run-2', 'running'),
      createTask('done-1', 'completed'),
      createTask('fail-1', 'failed'),
    ]

    expect(getAdjacentGroupTaskId(tasks, 'run-2', 'right')).toBe('done-1')
    expect(getAdjacentGroupTaskId(tasks, 'done-1', 'right')).toBe('fail-1')
  })

  test('向左应跳到上一个非空阶段的首个任务', () => {
    const tasks: Task[] = [
      createTask('run-1', 'running'),
      createTask('pending-1', 'pending'),
      createTask('done-1', 'completed'),
      createTask('done-2', 'completed'),
    ]

    expect(getAdjacentGroupTaskId(tasks, 'done-2', 'left')).toBe('pending-1')
    expect(getAdjacentGroupTaskId(tasks, 'pending-1', 'left')).toBe('run-1')
  })

  test('边界阶段继续左右切换时保持当前选择不变', () => {
    const tasks: Task[] = [createTask('run-1', 'running'), createTask('fail-1', 'failed')]

    expect(getAdjacentGroupTaskId(tasks, 'run-1', 'left')).toBe('run-1')
    expect(getAdjacentGroupTaskId(tasks, 'fail-1', 'right')).toBe('fail-1')
  })
})
