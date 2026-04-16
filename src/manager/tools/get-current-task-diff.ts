import { getUncommittedDiff } from '../../utils/git'
import type { ManagerTools } from '../runtime'

export async function getCurrentTaskDiff(
  missionWorktree: string | undefined,
): Promise<ReturnType<ManagerTools['get_current_task_diff']>> {
  if (!missionWorktree) return ''
  return getUncommittedDiff(missionWorktree)
}
