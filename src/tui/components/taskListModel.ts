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

export function getAdjacentGroupTaskId(
  tasks: Task[],
  selectedTaskId: string | null,
  direction: 'left' | 'right',
): string | null {
  const groups = GROUP_ORDER.map((status) => ({
    status,
    tasks: tasks.filter((task) => getGroupKey(task.status) === status),
  })).filter((group) => group.tasks.length > 0)

  if (groups.length === 0) return null

  if (!selectedTaskId) return groups[0]?.tasks[0]?.id || null

  const currentGroupIndex = groups.findIndex((group) =>
    group.tasks.some((task) => task.id === selectedTaskId),
  )

  if (currentGroupIndex === -1) return groups[0]?.tasks[0]?.id || null

  const offset = direction === 'left' ? -1 : 1
  const targetGroup = groups[currentGroupIndex + offset]

  if (!targetGroup) return selectedTaskId

  return targetGroup.tasks[0]?.id || selectedTaskId
}
