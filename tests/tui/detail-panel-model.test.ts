import { describe, expect, test } from 'bun:test'
import { getActiveTaskSlaves, isActiveTask } from '../../src/tui/components/detailPanelModel'
import type { SlaveInfo, Task } from '../../src/types'

function task(status: Task['status']): Task {
  const now = new Date().toISOString()
  return {
    id: 'task-1',
    type: 'other',
    status,
    priority: 1,
    description: 'test task',
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    maxAttempts: 3,
    reviewHistory: [],
  }
}

function slave(overrides: Partial<SlaveInfo>): SlaveInfo {
  return {
    id: 'worker-1',
    type: 'worker',
    status: 'busy',
    currentTask: 'task-1',
    startedAt: '2026-04-08T10:00:00.000Z',
    ...overrides,
  }
}

describe('detailPanelModel', () => {
  test('assigned 和 reviewing 任务应视为工作中', () => {
    expect(isActiveTask(task('assigned'))).toBe(true)
    expect(isActiveTask(task('reviewing'))).toBe(true)
    expect(isActiveTask(task('completed'))).toBe(false)
  })

  test('仅返回当前任务的 busy slaves，并按启动时间排序', () => {
    const result = getActiveTaskSlaves('task-1', [
      slave({ id: 'worker-2', startedAt: '2026-04-08T10:00:02.000Z' }),
      slave({ id: 'worker-1', startedAt: '2026-04-08T10:00:01.000Z' }),
      slave({ id: 'idle-worker', status: 'idle' }),
      slave({ id: 'other-task', currentTask: 'task-2' }),
    ])

    expect(result.map((entry) => entry.id)).toEqual(['worker-1', 'worker-2'])
  })
})
