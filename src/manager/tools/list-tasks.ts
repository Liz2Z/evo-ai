import type { Task } from '../../types'
import { loadTasks } from '../../utils/storage'
import type { ManagerTools } from '../runtime'

export async function listTasks(
  input?: Parameters<ManagerTools['list_tasks']>[0],
): Promise<Task[]> {
  const tasks = await loadTasks()
  if (!input?.status) return tasks
  const statuses = Array.isArray(input.status) ? input.status : [input.status]
  return tasks.filter((task) => statuses.includes(task.status))
}
