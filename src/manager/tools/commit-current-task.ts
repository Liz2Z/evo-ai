import type { CommitTaskResult } from '../runtime'

export interface CommitCurrentTaskDeps {
  commitCurrentTask: () => Promise<CommitTaskResult>
}

export async function commitCurrentTaskTool(
  _params: undefined,
  deps: CommitCurrentTaskDeps,
): Promise<CommitTaskResult> {
  return deps.commitCurrentTask()
}
