import type { SlaveInfo, Task } from '../../types'

const ACTIVE_TASK_STATUSES: Task['status'][] = ['running', 'reviewing']

export function isActiveTask(task: Task | null): boolean {
  if (!task) return false
  return ACTIVE_TASK_STATUSES.includes(task.status)
}

export function getActiveTaskSlaves(taskId: string | null, slaves: SlaveInfo[]): SlaveInfo[] {
  if (!taskId) return []

  return slaves
    .filter((slave) => slave.status === 'busy' && slave.currentTask === taskId)
    .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''))
}
