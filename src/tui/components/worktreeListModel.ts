import type { Task, TaskStatus } from '../../types'

export const GROUP_ORDER: TaskStatus[] = [
  'running',
  'assigned',
  'reviewing',
  'pending',
  'approved',
  'completed',
  'failed',
  'rejected',
]

export function getGroupKey(status: TaskStatus): string {
  if (status === 'assigned') return 'running'
  return status
}

export function getGroupedTaskIds(tasks: Task[]): string[] {
  const grouped = new Map<string, Task[]>()

  for (const task of tasks) {
    const key = getGroupKey(task.status)
    const group = grouped.get(key) || []
    group.push(task)
    grouped.set(key, group)
  }

  const orderedIds: string[] = []

  for (const status of GROUP_ORDER) {
    const group = grouped.get(status)
    if (!group || group.length === 0) continue

    for (const task of group) {
      orderedIds.push(task.id)
    }
  }

  return orderedIds
}
