import type { ManagerTools } from '../runtime'

export interface CancelTaskDeps {
  cancelTask: (taskId: string) => Promise<boolean>
}

export async function cancelTaskTool(
  { taskId }: Parameters<ManagerTools['cancel_task']>[0],
  deps: CancelTaskDeps,
): Promise<ReturnType<ManagerTools['cancel_task']>> {
  const { cancelTask: cancel } = deps
  return {
    status: (await cancel(taskId)) ? 'cancelled' : 'noop',
    taskId,
  }
}
