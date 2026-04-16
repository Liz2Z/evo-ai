import type { ManagerTools } from '../runtime'
import type { AgentHandle, AgentOptions } from '../../agents/launcher'
import type { HistoryEntry, Task } from '../../types'
import type { SanitizedInspectorTasks } from '../task-sanitizer'

interface SimpleLogger {
  info(message: string): void
  error(message: string): void
}

export interface LaunchInspectorDeps {
  refreshActiveAgents: () => Promise<void>
  activeAgents: number
  currentTaskId: string | undefined
  loadTasks: () => Promise<Task[]>
  setState: (updates: Partial<{ currentStage: string; lastInspection?: string }>) => Promise<void>
  emitManagerState: () => void
  incrementActiveAgents: () => void
  getRecentDecisions: () => Promise<string[]>
  createAgentHandle: (config: AgentOptions) => AgentHandle
  activeAgentHandles: Map<string, AgentHandle>
  addHistoryEntry: (entry: Omit<HistoryEntry, 'taskId' | 'agentId'> & { taskId?: string; agentId?: string }) => Promise<void>
  sanitizeInspectorTasks: (rawTasks: Task[], existingTasks: Task[]) => SanitizedInspectorTasks
  parseInspectorTasksFromResult: (summary: string, mission: string) => Task[]
  addTask: (task: Task) => Promise<void>
  requestTurn: (reason: string) => Promise<void>
  logger: SimpleLogger
  state: { mission: string; currentStage: string }
}

export async function launchInspector(
  { reason }: Parameters<ManagerTools['launch_inspector']>[0],
  deps: LaunchInspectorDeps,
): Promise<ReturnType<ManagerTools['launch_inspector']>> {
  const {
    refreshActiveAgents,
    activeAgents,
    currentTaskId,
    loadTasks,
    setState,
    emitManagerState,
    incrementActiveAgents,
    getRecentDecisions,
    createAgentHandle: createHandle,
    activeAgentHandles,
    addHistoryEntry,
    sanitizeInspectorTasks,
    parseInspectorTasksFromResult,
    addTask,
    requestTurn,
    logger,
    state,
  } = deps

  await refreshActiveAgents()
  const tasks = await loadTasks()
  const hasActiveQueue = tasks.some((task) =>
    ['pending', 'running', 'reviewing'].includes(task.status),
  )
  if (activeAgents > 0 || currentTaskId || hasActiveQueue) {
    return { status: 'noop', createdTaskIds: [], message: 'Mission queue is not idle' }
  }

  await setState({ currentStage: 'inspecting' })
  emitManagerState()
  incrementActiveAgents()

  const recentDecisions = await getRecentDecisions()
  const launcher = createHandle({
    type: 'inspector',
    task: {
      id: 'inspection',
      type: 'other',
      status: 'running',
      priority: 1,
      description: '检查代码库并生成后续任务',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 0,
      maxAttempts: 1,
      reviewHistory: [],
    },
    mission: state.mission,
    recentDecisions,
    onError: (error) => logger.error(`Inspector failed: ${error}`),
  })
  activeAgentHandles.set('inspection', launcher)

  void launcher
    .start()
    .then(() => launcher.execute())
    .then(async (newTasks) => {
      activeAgentHandles.delete('inspection')
      const existingTasks = await loadTasks()
      const rawTasks =
        newTasks && 'summary' in newTasks
          ? parseInspectorTasksFromResult(newTasks.summary, state.mission)
          : []
      const { accepted, dropped } = sanitizeInspectorTasks(rawTasks, existingTasks)
      const createdTaskIds: string[] = []
      for (const task of accepted) {
        await addTask(task)
        createdTaskIds.push(task.id)
        await addHistoryEntry({
          timestamp: new Date().toISOString(),
          type: 'task_created',
          taskId: task.id,
          summary: `Inspector created task: ${task.description.slice(0, 100)}`,
        })
      }

      for (const item of dropped) {
        logger.info(
          `Dropped inspector task (${item.reason}): ${item.task.description.slice(0, 120)}`,
        )
      }

      await setState({
        currentStage: 'idle',
        lastInspection: new Date().toISOString(),
      })
      await requestTurn(`inspector_completed:${reason}`)
    })
    .catch(async (error) => {
      activeAgentHandles.delete('inspection')
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'error',
        summary: `Inspector failed: ${error}`,
      })
      await setState({ currentStage: 'idle' })
      await requestTurn('inspector_failed')
    })

  return { status: 'started', createdTaskIds: [], message: `Inspector launched (${reason})` }
}
