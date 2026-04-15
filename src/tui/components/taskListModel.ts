import type { Task, TaskStatus } from '../../types'

export const GROUP_ORDER: TaskStatus[] = ['running', 'reviewing', 'pending', 'completed', 'failed']

export function getGroupKey(status: TaskStatus): TaskStatus {
  return status
}

export function getGroupedTaskIds(tasks: Task[]): string[] {
  const grouped = new Map<TaskStatus, Task[]>()

  for (const task of tasks) {
    const key = getGroupKey(task.status)
    const group = grouped.get(key) || []
    group.push(task)
    grouped.set(key, group)
  }

  const orderedIds: string[] = []
  for (const status of GROUP_ORDER) {
    const group = grouped.get(status)
    if (!group) continue
    for (const task of group) orderedIds.push(task.id)
  }
  return orderedIds
}
