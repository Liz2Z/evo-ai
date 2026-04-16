import type { Task, TaskResult } from '../../types'
import type { WorkerAssignmentResult } from '../runtime'
import type { AgentHandle, AgentOptions } from '../../agents/launcher'

type TaskStatus = Task['status']

export interface AssignWorkerDeps {
  getTaskById: (taskId: string) => Promise<Task | null>
  ensureMissionWorkspaceReady: () => Promise<{ status: 'ready' | 'failed'; path?: string; message: string }>
  updateTask: (taskId: string, updates: Partial<Task>) => Promise<Task | null>
  setState: (updates: Partial<{ currentTaskId: string; currentStage: string }>) => Promise<void>
  emitTaskStatusChange: (taskId: string, fromStatus: TaskStatus, toStatus: TaskStatus, task: Task) => void
  emitManagerState: () => void
  incrementActiveAgents: () => void
  getRecentDecisions: () => Promise<string[]>
  createAgentHandle: (config: AgentOptions) => AgentHandle
  activeAgentHandles: Map<string, AgentHandle>
  requestTurn: (reason: string) => Promise<void>
  handleWorkerResult: (taskId: string, result: TaskResult) => Promise<void>
  failTask: (taskId: string, reason: string) => Promise<void>
  activeAgents: number
  state: { currentTaskId?: string; currentStage: string; mission: string }
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
    .then(async (result) => {
      activeAgentHandles.delete(freshTask.id)
      if (result && 'status' in result && 'filesChanged' in result) {
        await handleWorkerResult(freshTask.id, result)
      } else if (!result) {
        await failTask(freshTask.id, 'Worker returned no result')
      } else {
        await failTask(freshTask.id, 'Worker returned unexpected result type')
      }
      await requestTurn(`worker_completed:${freshTask.id}`)
    })
    .catch(async (error) => {
      activeAgentHandles.delete(freshTask.id)
      await failTask(freshTask.id, error instanceof Error ? error.message : String(error))
      await requestTurn(`worker_failed:${freshTask.id}`)
    })

  return { status: 'started', taskId: freshTask.id, message: 'Worker assigned' }
}
