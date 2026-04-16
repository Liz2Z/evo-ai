import type { ReviewResult, Task } from '../../types'
import { getUncommittedDiff } from '../../utils/git'
import type { ReviewerAssignmentResult } from '../runtime'
import type { AgentHandle, AgentOptions } from '../../agents/launcher'

export interface AssignReviewerDeps {
  getTaskById: (taskId: string) => Promise<Task | null>
  validateMissionWorktree: () => string | null
  setState: (updates: Partial<{ currentTaskId: string; currentStage: string }>) => Promise<void>
  emitManagerState: () => void
  incrementActiveAgents: () => void
  getRecentDecisions: () => Promise<string[]>
  createAgentHandle: (config: AgentOptions) => AgentHandle
  activeAgentHandles: Map<string, AgentHandle>
  requestTurn: (reason: string) => Promise<void>
  handleReviewResult: (taskId: string, result: ReviewResult) => Promise<void>
  failTask: (taskId: string, reason: string) => Promise<void>
  activeAgents: number
  state: { currentTaskId?: string; currentStage: string; mission: string }
}

export async function assignReviewer(
  { taskId }: { taskId: string },
  deps: AssignReviewerDeps,
): Promise<ReviewerAssignmentResult> {
  const {
    getTaskById,
    validateMissionWorktree,
    setState,
    emitManagerState,
    incrementActiveAgents,
    getRecentDecisions,
    createAgentHandle: createHandle,
    activeAgentHandles,
    requestTurn,
    handleReviewResult,
    failTask,
    activeAgents,
    state,
  } = deps

  const freshTask = await getTaskById(taskId)
  if (!freshTask) {
    return { status: 'not_found', taskId, message: 'Task not found' }
  }
  if (freshTask.status !== 'reviewing') {
    return { status: 'noop', taskId, message: `Task is ${freshTask.status}` }
  }
  const worktreePath = validateMissionWorktree()
  if (!worktreePath) {
    return { status: 'noop', taskId, message: 'Mission workspace is missing or invalid' }
  }
  if (activeAgents > 0) {
    return { status: 'noop', taskId, message: 'Another agent is already active' }
  }

  const diff = await getUncommittedDiff(worktreePath)
  if (!diff.trim()) {
    await failTask(taskId, 'No diff to review in mission workspace')
    return { status: 'noop', taskId, message: 'No diff to review' }
  }

  await setState({
    currentTaskId: taskId,
    currentStage: 'reviewing',
  })
  emitManagerState()

  incrementActiveAgents()
  const recentDecisions = await getRecentDecisions()
  const launcher = createHandle({
    type: 'reviewer',
    task: freshTask,
    mission: state.mission,
    recentDecisions,
    additionalContext: `## Code Changes to Review\n\`\`\`diff\n${diff}\n\`\`\``,
    worktreePath,
  })
  activeAgentHandles.set(taskId, launcher)

  void launcher
    .start()
    .then(() => launcher.execute())
    .then(async (result) => {
      activeAgentHandles.delete(taskId)
      if (result && 'verdict' in result && 'confidence' in result) {
        await handleReviewResult(taskId, result)
      } else if (!result) {
        await failTask(taskId, 'Reviewer returned no result')
      } else {
        await failTask(taskId, 'Reviewer returned unexpected result type')
      }
      await requestTurn(`review_completed:${taskId}`)
    })
    .catch(async (error) => {
      activeAgentHandles.delete(taskId)
      await failTask(taskId, error instanceof Error ? error.message : String(error))
      await requestTurn(`review_failed:${taskId}`)
    })

  return { status: 'started', taskId, message: 'Reviewer assigned' }
}
