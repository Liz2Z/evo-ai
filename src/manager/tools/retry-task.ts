import type { Task } from '../../types'
import { updateTask } from '../../utils/storage'
import type { ManagerTools } from '../runtime'

export interface RetryTaskDeps {
  getTaskById: (taskId: string) => Promise<Task | null>
}

export async function retryTask(
  { taskId, additionalContext }: Parameters<ManagerTools['retry_task']>[0],
  deps: RetryTaskDeps,
): Promise<ReturnType<ManagerTools['retry_task']>> {
  const { getTaskById } = deps
  const task = await getTaskById(taskId)
  if (!task) return { status: 'not_found', taskId }
  if (task.status !== 'failed') return { status: 'noop', taskId }
  const context = additionalContext
    ? task.context
      ? `${task.context}\n\n${additionalContext}`
      : additionalContext
    : task.context
  await updateTask(task.id, { status: 'pending', context })
  return { status: 'retried', taskId }
}
