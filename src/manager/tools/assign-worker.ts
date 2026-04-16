import type { Task } from '../../types'
import type { WorkerAssignmentResult } from '../runtime'

type TaskStatus = Task['status']

export interface AssignWorkerDeps {
  getTaskById: (taskId: string) => Promise<Task | null>
  ensureMissionWorkspaceReady: () => Promise<any>
  updateTask: (taskId: string, updates: any) => Promise<any>
  setState: (updates: any) => Promise<void>
  emitTaskStatusChange: (taskId: string, fromStatus: TaskStatus, toStatus: TaskStatus, task: Task) => void
  emitManagerState: () => void
  incrementActiveAgents: () => void
  getRecentDecisions: () => Promise<string[]>
  createAgentHandle: (config: any) => any
  activeAgentHandles: Map<string, any>
  requestTurn: (reason: string) => Promise<void>
  handleWorkerResult: (taskId: string, result: any) => Promise<void>
  failTask: (taskId: string, reason: string) => Promise<void>
  activeAgents: number
  state: { currentTaskId?: string | undefined; currentStage: string; mission: string }
}

export async function assignWorker(
  { taskId, additionalContext }: { taskId: string; additionalContext?: string },
  deps: AssignWorkerDeps,
): Promise<WorkerAssignmentResult> {
  const {
    getTaskById,
    ensureMissionWorkspaceReady,
    updateTask,
    setState,
    emitTaskStatusChange,
    emitManagerState,
    incrementActiveAgents,
    getRecentDecisions,
    createAgentHandle: createHandle,
    activeAgentHandles,
    requestTurn,
    handleWorkerResult,
    failTask,
    activeAgents,
    state,
  } = deps

  const freshTask = await getTaskById(taskId)
  if (!freshTask) {
    return { status: 'not_found', taskId, message: 'Task not found' }
  }
  if (!['pending', 'running'].includes(freshTask.status)) {
    return { status: 'noop', taskId, message: `Task is ${freshTask.status}` }
  }
  if (activeAgents > 0) {
    return { status: 'noop', taskId, message: 'Another agent is already active' }
  }

  const workspace = await ensureMissionWorkspaceReady()
  if (workspace.status === 'failed' || !workspace.path) {
    return { status: 'noop', taskId, message: workspace.message }
  }

  const beforeStatus = freshTask.status
  await updateTask(freshTask.id, { status: 'running' })
  await setState({
    currentTaskId: freshTask.id,
    currentStage: 'working',
  })
  emitTaskStatusChange(freshTask.id, beforeStatus, 'running', {
    ...freshTask,
    status: 'running',
  })
  emitManagerState()

  incrementActiveAgents()
  const recentDecisions = await getRecentDecisions()
  const launcher = createHandle({
    type: 'worker',
    task: { ...freshTask, status: 'running' },
    mission: state.mission,
    recentDecisions,
    additionalContext,
    worktreePath: workspace.path,
  })
  activeAgentHandles.set(freshTask.id, launcher)

  void launcher
    .start()
    .then(() => launcher.execute())
    .then(async (result: any) => {
      activeAgentHandles.delete(freshTask.id)
      if (result) {
        await handleWorkerResult(freshTask.id, result)
      } else {
        await failTask(freshTask.id, 'Worker returned no result')
      }
      await requestTurn(`worker_completed:${freshTask.id}`)
    })
    .catch(async (error: any) => {
      activeAgentHandles.delete(freshTask.id)
      await failTask(freshTask.id, error instanceof Error ? error.message : String(error))
      await requestTurn(`worker_failed:${freshTask.id}`)
    })

  return { status: 'started', taskId: freshTask.id, message: 'Worker assigned' }
}
