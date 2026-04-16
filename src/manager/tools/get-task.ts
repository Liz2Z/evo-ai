import type { Task } from '../../types'
import { loadTasks } from '../../utils/storage'
import type { ManagerTools } from '../runtime'

export async function getTask({
  taskId,
}: Parameters<ManagerTools['get_task']>[0]): Promise<Task | null> {
  const tasks = await loadTasks()
  return tasks.find((task) => task.id === taskId) || null
}
