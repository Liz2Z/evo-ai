import { updateTask as updateTaskStorage } from '../../utils/storage'

export async function updateTask(
  { taskId, patch }: { taskId: string; patch: Partial<any> },
): Promise<any> {
  return updateTaskStorage(taskId, patch)
}
