import type { Task } from '../../types'
import { updateTask as updateTaskStorage } from '../../utils/storage'

export async function updateTask(
  { taskId, patch }: { taskId: string; patch: Partial<Task> },
): Promise<Task | null> {
  return updateTaskStorage(taskId, patch)
}
