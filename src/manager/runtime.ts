import { Type } from '@mariozechner/pi-ai'
import { defineTool, type ToolDefinition } from '@mariozechner/pi-coding-agent'
import {
  abortPiSession,
  createPiSession,
  disposePiSession,
  type PiSessionLifecycle,
} from '../agent/pi'
import { getConfiguredModel } from '../config'
import type {
  AgentInfo,
  Config,
  HistoryEntry,
  ManagerRuntimeMode,
  ManagerState,
  ManagerUserMessage,
  Question,
  Task,
} from '../types'
import { decisionEngine } from './decision'

export interface ManagerRuntimeContext {
  triggerReason: string
  timestamp: string
  mission: string
  config: Config
  managerState: ManagerState
  tasks: Task[]
  agents: AgentInfo[]
  recentHistory: HistoryEntry[]
  userMessages: ManagerUserMessage[]
}

export interface ManagerSnapshot {
  mission: string
  runtimeMode: ManagerRuntimeMode
  currentPhase: string
  turnStatus: ManagerState['turnStatus']
  activeAgents: number
  maxConcurrency: number
  pendingCount: number
  pendingQuestions: Question[]
  lastHeartbeat: string
  lastDecisionAt: string
  skippedWakeups: number
  lastSkippedTriggerReason?: string
  runtimeSessionSummary?: string
  missionBranch?: string
  missionWorktree?: string
  currentTaskId?: string
  currentStage: ManagerState['currentStage']
  pendingUserMessages: ManagerUserMessage[]
}

export interface ManagerRuntimeTurnResult {
  summary: string
  toolCalls: string[]
  unauthorizedToolCalls: string[]
  sessionSummary?: string
}

export interface WorkerAssignmentResult {
  status: 'started' | 'noop' | 'not_found'
  taskId: string
  message: string
}

export interface ReviewerAssignmentResult {
  status: 'started' | 'noop' | 'not_found'
  taskId: string
  message: string
}

export interface CommitTaskResult {
  status: 'committed' | 'noop' | 'failed' | 'not_found'
  taskId?: string
  message: string
}

export interface CompleteMissionResult {
  status: 'merged' | 'noop' | 'failed'
  message: string
}

export interface MissionWorkspaceResult {
  status: 'ready' | 'failed'
  path?: string
  branch?: string
  message: string
}

export interface ManagerTools {
  get_manager_snapshot(): Promise<ManagerSnapshot>
  list_tasks(input?: { status?: Task['status'] | Task['status'][] }): Promise<Task[]>
  list_agents(): Promise<AgentInfo[]>
  get_task(input: { taskId: string }): Promise<Task | null>
  get_recent_history(input?: { limit?: number }): Promise<HistoryEntry[]>
  get_current_task_diff(): Promise<string>
  ensure_mission_workspace(): Promise<MissionWorkspaceResult>
  launch_inspector(input: { reason: string }): Promise<{
    status: 'started' | 'noop'
    createdTaskIds: string[]
    message: string
  }>
  assign_worker(input: {
    taskId: string
    additionalContext?: string
  }): Promise<WorkerAssignmentResult>
  assign_reviewer(input: { taskId: string }): Promise<ReviewerAssignmentResult>
  create_task(input: {
    description: string
    type?: Task['type']
    priority?: number
    context?: string
  }): Promise<Task>
  update_task(input: { taskId: string; patch: Partial<Task> }): Promise<Task | null>
  cancel_task(input: { taskId: string }): Promise<{ status: 'cancelled' | 'noop'; taskId: string }>
  retry_task(input: {
    taskId: string
    additionalContext?: string
  }): Promise<{ status: 'retried' | 'noop' | 'not_found'; taskId: string }>
  commit_current_task(): Promise<CommitTaskResult>
  complete_mission(): Promise<CompleteMissionResult>
  ask_human(input: { question: string; options?: string[] }): Promise<Question>
}

export interface ManagerRuntime {
  init(context: ManagerRuntimeContext, tools: ManagerTools): Promise<void>
  runTurn(context: ManagerRuntimeContext, tools: ManagerTools): Promise<ManagerRuntimeTurnResult>
  dispose(): Promise<void>
  onExternalEvent?(event: { reason: string; timestamp: string }): Promise<void> | void
  cancelCurrentTurn?(): Promise<void>
}

export type ClaudeManagerExecutor = (params: {
  context: ManagerRuntimeContext
  tools: ManagerTools
  sessionHints: string[]
  sessionId?: string
  onSessionStart?: (session: PiSessionLifecycle) => void
  invokeTool: (name: keyof ManagerTools, args?: unknown) => Promise<unknown>
  allowedToolNames: Set<keyof ManagerTools>
}) => Promise<{ summary: string; sessionId?: string }>

const TASK_STATUSES = ['pending', 'running', 'reviewing', 'completed', 'failed'] as const
const TASK_TYPES = ['fix', 'feature', 'refactor', 'test', 'docs', 'other'] as const

export class ManagerAgentAdapter {
  private readonly allowedTools = new Set<keyof ManagerTools>([
    'get_manager_snapshot',
    'list_tasks',
    'list_agents',
    'get_task',
    'get_recent_history',
    'get_current_task_diff',
    'ensure_mission_workspace',
    'launch_inspector',
    'assign_worker',
    'assign_reviewer',
    'create_task',
    'update_task',
    'cancel_task',
    'retry_task',
    'commit_current_task',
    'complete_mission',
    'ask_human',
  ])

  constructor(private readonly executor: ClaudeManagerExecutor = executeClaudeManagerTurn) {}

  async callTool(name: string, args: unknown, tools: ManagerTools): Promise<unknown> {
    if (!this.allowedTools.has(name as keyof ManagerTools)) {
      throw new Error(`Unauthorized manager tool: ${name}`)
    }

    const toolFn = tools[name as keyof ManagerTools] as
      | ((input?: unknown) => Promise<unknown>)
      | undefined
    if (!toolFn) {
      throw new Error(`Unknown manager tool: ${name}`)
    }

    return toolFn(args)
  }

  async run(
    context: ManagerRuntimeContext,
    tools: ManagerTools,
    sessionHints: string[] = [],
    sessionId?: string,
    onSessionStart?: (session: PiSessionLifecycle) => void,
  ): Promise<ManagerRuntimeTurnResult & { sessionId?: string }> {
    const toolCalls: string[] = []
    const unauthorizedToolCalls: string[] = []

    const invokeTool = async (name: keyof ManagerTools, args?: unknown): Promise<unknown> => {
      try {
        const result = await this.callTool(name, args, tools)
        toolCalls.push(name)
        return result
      } catch (error) {
        if ((error as Error).message.startsWith('Unauthorized manager tool:')) {
          unauthorizedToolCalls.push(name)
        }
        throw error
      }
    }

    const result = await this.executor({
      context,
      tools,
      sessionHints,
      sessionId,
      onSessionStart,
      invokeTool,
      allowedToolNames: this.allowedTools,
    })

    return {
      summary: result.summary,
      toolCalls,
      unauthorizedToolCalls,
      sessionSummary: buildSessionSummary(context, toolCalls, sessionHints),
      sessionId: result.sessionId,
    }
  }
}

class HeartbeatManagerRuntime implements ManagerRuntime {
  private readonly adapter: ManagerAgentAdapter
  private readonly fallbackRuntime: HybridManagerRuntime
  private activeSession?: PiSessionLifecycle

  constructor(adapter?: ManagerAgentAdapter) {
    this.adapter = adapter || new ManagerAgentAdapter()
    this.fallbackRuntime = new HybridManagerRuntime()
  }

  async init(_context: ManagerRuntimeContext, _tools: ManagerTools): Promise<void> {}

  async runTurn(
    context: ManagerRuntimeContext,
    tools: ManagerTools,
  ): Promise<ManagerRuntimeTurnResult> {
    try {
      const result = await this.adapter.run(context, tools, [], undefined, (session) => {
        this.activeSession = session
      })
      if (result.toolCalls.length > 0) {
        return {
          summary: result.summary,
          toolCalls: result.toolCalls,
          unauthorizedToolCalls: result.unauthorizedToolCalls,
          sessionSummary: result.sessionSummary,
        }
      }

      const fallback = await this.fallbackRuntime.runTurn(context, tools)
      return {
        summary: `${result.summary}\nFallback: ${fallback.summary}`,
        toolCalls: fallback.toolCalls,
        unauthorizedToolCalls: [...result.unauthorizedToolCalls, ...fallback.unauthorizedToolCalls],
        sessionSummary: result.sessionSummary,
      }
    } catch (error) {
      const fallback = await this.fallbackRuntime.runTurn(context, tools)
      return {
        summary: `Adapter failed: ${(error as Error).message}\nFallback: ${fallback.summary}`,
        toolCalls: fallback.toolCalls,
        unauthorizedToolCalls: fallback.unauthorizedToolCalls,
      }
    }
  }

  async cancelCurrentTurn(): Promise<void> {
    await abortPiSession(this.activeSession)
    this.activeSession = undefined
  }

  async dispose(): Promise<void> {}
}

class SessionManagerRuntime implements ManagerRuntime {
  private readonly adapter: ManagerAgentAdapter
  private sessionHints: string[] = []
  private sessionId?: string
  private activeSession?: PiSessionLifecycle

  constructor(adapter?: ManagerAgentAdapter, initialSummary?: string) {
    this.adapter = adapter || new ManagerAgentAdapter()
    if (initialSummary) this.sessionHints.push(initialSummary)
  }

  async init(_context: ManagerRuntimeContext, _tools: ManagerTools): Promise<void> {}

  async onExternalEvent(event: { reason: string; timestamp: string }): Promise<void> {
    this.sessionHints.push(`${event.timestamp}:${event.reason}`)
    this.sessionHints = this.sessionHints.slice(-20)
  }

  async runTurn(
    context: ManagerRuntimeContext,
    tools: ManagerTools,
  ): Promise<ManagerRuntimeTurnResult> {
    const result = await this.adapter.run(
      context,
      tools,
      this.sessionHints,
      this.sessionId,
      (session) => {
        this.activeSession = session
      },
    )
    this.sessionId = result.sessionId || this.sessionId
    this.sessionHints.push(result.summary)
    this.sessionHints = this.sessionHints.slice(-20)

    return {
      summary: result.summary,
      toolCalls: result.toolCalls,
      unauthorizedToolCalls: result.unauthorizedToolCalls,
      sessionSummary: this.sessionHints.join('\n'),
    }
  }

  async dispose(): Promise<void> {
    this.sessionHints = []
    this.sessionId = undefined
  }

  async cancelCurrentTurn(): Promise<void> {
    await abortPiSession(this.activeSession)
    this.activeSession = undefined
  }
}

class HybridManagerRuntime implements ManagerRuntime {
  async init(_context: ManagerRuntimeContext, _tools: ManagerTools): Promise<void> {}

  async runTurn(
    context: ManagerRuntimeContext,
    tools: ManagerTools,
  ): Promise<ManagerRuntimeTurnResult> {
    const toolCalls: string[] = []
    const unauthorizedToolCalls: string[] = []

    const snapshot = await tools.get_manager_snapshot()
    toolCalls.push('get_manager_snapshot')

    const workspace = await tools.ensure_mission_workspace()
    toolCalls.push('ensure_mission_workspace')
    if (workspace.status === 'failed') {
      return {
        summary: `Mission workspace failed: ${workspace.message}`,
        toolCalls,
        unauthorizedToolCalls,
      }
    }

    const unansweredQuestions = snapshot.pendingQuestions.filter((q) => !q.answered)
    const pendingQuestionTexts = unansweredQuestions.map((q) => q.question)
    const decision = await decisionEngine.decide({
      mission: context.mission,
      recentHistory: context.recentHistory,
      currentTasks: context.tasks,
      pendingQuestions: pendingQuestionTexts,
    })

    if (decision.action === 'ask_human' && decision.data?.question) {
      await tools.ask_human({
        question: decision.data.question,
        options: decision.data.options || [],
      })
      toolCalls.push('ask_human')
    }

    if (snapshot.currentTaskId) {
      const currentTask = context.tasks.find((task) => task.id === snapshot.currentTaskId)
      if (!currentTask) {
        return {
          summary: 'Current task pointer is stale',
          toolCalls,
          unauthorizedToolCalls,
        }
      }

      if (snapshot.currentStage === 'committing') {
        const commitResult = await tools.commit_current_task()
        toolCalls.push('commit_current_task')
        return {
          summary:
            commitResult.status === 'committed'
              ? `Committed task ${currentTask.id}`
              : `Commit blocked for ${currentTask.id}: ${commitResult.message}`,
          toolCalls,
          unauthorizedToolCalls,
        }
      }

      if (snapshot.activeAgents > 0) {
        return {
          summary: `Waiting for active agent on task ${currentTask.id}`,
          toolCalls,
          unauthorizedToolCalls,
        }
      }

      if (currentTask.status === 'reviewing') {
        await tools.assign_reviewer({ taskId: currentTask.id })
        toolCalls.push('assign_reviewer')
        return {
          summary: `Reviewer assigned to ${currentTask.id}`,
          toolCalls,
          unauthorizedToolCalls,
        }
      }

      if (currentTask.status === 'running' || currentTask.status === 'pending') {
        await tools.assign_worker({ taskId: currentTask.id })
        toolCalls.push('assign_worker')
        return {
          summary: `Worker assigned to ${currentTask.id}`,
          toolCalls,
          unauthorizedToolCalls,
        }
      }
    }

    const openTasks = context.tasks.filter((task) =>
      ['pending', 'running', 'reviewing'].includes(task.status),
    )
    const hasTaskHistory = context.tasks.length > 0
    const shouldCompleteMission =
      snapshot.activeAgents === 0 &&
      !snapshot.currentTaskId &&
      openTasks.length === 0 &&
      hasTaskHistory &&
      Boolean(snapshot.missionBranch) &&
      Boolean(snapshot.missionWorktree)

    if (shouldCompleteMission) {
      const completeResult = await tools.complete_mission()
      toolCalls.push('complete_mission')
      return {
        summary:
          completeResult.status === 'merged'
            ? `Mission merged into ${context.config.developBranch}`
            : `Mission completion blocked: ${completeResult.message}`,
        toolCalls,
        unauthorizedToolCalls,
      }
    }

    const pendingTasks = decisionEngine.prioritizeTasks(
      context.tasks.filter((task) => task.status === 'pending').slice(),
    )
    if (snapshot.activeAgents === 0 && pendingTasks.length > 0) {
      await tools.assign_worker({ taskId: pendingTasks[0].id })
      toolCalls.push('assign_worker')
      return {
        summary: `Worker assigned to ${pendingTasks[0].id}`,
        toolCalls,
        unauthorizedToolCalls,
      }
    }

    const shouldInspect =
      snapshot.activeAgents === 0 &&
      !snapshot.currentTaskId &&
      context.tasks.length === 0 &&
      context.tasks.filter((task) => ['pending', 'running', 'reviewing'].includes(task.status))
        .length === 0 &&
      decisionEngine.shouldInspect({
        mission: context.mission,
        recentHistory: context.recentHistory,
        currentTasks: context.tasks,
        pendingQuestions: pendingQuestionTexts,
      })

    if (shouldInspect) {
      await tools.launch_inspector({ reason: `trigger=${context.triggerReason}` })
      toolCalls.push('launch_inspector')
      return {
        summary: 'Inspector launched',
        toolCalls,
        unauthorizedToolCalls,
      }
    }

    return {
      summary: 'Hybrid runtime idle',
      toolCalls,
      unauthorizedToolCalls,
    }
  }

  async dispose(): Promise<void> {}
}

export function createManagerRuntime(
  mode: ManagerRuntimeMode,
  _config: Config,
  state: ManagerState,
  options?: { agentExecutor?: ClaudeManagerExecutor },
): ManagerRuntime {
  const adapter = options?.agentExecutor
    ? new ManagerAgentAdapter(options.agentExecutor)
    : undefined

  if (mode === 'heartbeat_agent') return new HeartbeatManagerRuntime(adapter)
  if (mode === 'session_agent')
    return new SessionManagerRuntime(adapter, state.runtimeSessionSummary)
  return new HybridManagerRuntime()
}

async function executeClaudeManagerTurn(params: {
  context: ManagerRuntimeContext
  tools: ManagerTools
  sessionHints: string[]
  sessionId?: string
  onSessionStart?: (session: PiSessionLifecycle) => void
  invokeTool: (name: keyof ManagerTools, args?: unknown) => Promise<unknown>
  allowedToolNames: Set<keyof ManagerTools>
}): Promise<{ summary: string; sessionId?: string }> {
  const { context, sessionHints, invokeTool, allowedToolNames, sessionId, onSessionStart } = params
  const model = getConfiguredModel(context.config, 'manager') || context.config.models.manager
  const prompt = [buildManagerSystemPrompt(), buildManagerPrompt(context, sessionHints)]
    .filter(Boolean)
    .join('\n\n')
  const customTools = buildManagerPiTools(invokeTool, allowedToolNames)

  const { session } = await createPiSession({
    cwd: process.cwd(),
    config: context.config,
    modelId: model,
    tools: [],
    customTools,
  })
  onSessionStart?.(session)

  try {
    await session.prompt(prompt)
    const resultText = session.getLastAssistantText() || ''
    const assistantMessages = session.messages.filter(
      (item: any) => item?.role === 'assistant',
    ) as Array<{ stopReason?: string; errorMessage?: string }>
    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    if (lastAssistant?.stopReason === 'error') {
      throw new Error(lastAssistant.errorMessage || 'Manager agent returned error')
    }

    return {
      summary: resultText || 'Pi manager turn completed',
      sessionId,
    }
  } finally {
    disposePiSession(session)
  }
}

function buildManagerPiTools(
  invokeTool: (name: keyof ManagerTools, args?: unknown) => Promise<unknown>,
  allowedToolNames: Set<keyof ManagerTools>,
) {
  const statusSchema = Type.Union(TASK_STATUSES.map((status) => Type.Literal(status)))
  const taskTypeSchema = Type.Union(TASK_TYPES.map((type) => Type.Literal(type)))
  const toolDefs: ToolDefinition[] = []

  const pushTool = (
    name: keyof ManagerTools,
    description: string,
    parameters: ReturnType<typeof Type.Object>,
  ) => {
    if (!allowedToolNames.has(name)) return
    toolDefs.push(
      defineTool({
        name,
        label: name,
        description,
        parameters,
        execute: async (_toolCallId, args) => asPiToolResult(await invokeTool(name, args)),
      }),
    )
  }

  pushTool('get_manager_snapshot', 'Get current manager runtime snapshot.', Type.Object({}))
  pushTool(
    'list_tasks',
    'List tasks, optionally filtering by status or statuses.',
    Type.Object({
      status: Type.Optional(Type.Union([statusSchema, Type.Array(statusSchema)])),
    }),
  )
  pushTool('list_agents', 'List all agents and their states.', Type.Object({}))
  pushTool('get_task', 'Get a single task by id.', Type.Object({ taskId: Type.String() }))
  pushTool(
    'get_recent_history',
    'Get recent history entries.',
    Type.Object({ limit: Type.Optional(Type.Number({ minimum: 1 })) }),
  )
  pushTool(
    'get_current_task_diff',
    'Get uncommitted diff for the current mission workspace.',
    Type.Object({}),
  )
  pushTool(
    'ensure_mission_workspace',
    'Ensure the mission worktree and branch exist.',
    Type.Object({}),
  )
  pushTool(
    'launch_inspector',
    'Launch inspector to discover new tasks.',
    Type.Object({ reason: Type.String() }),
  )
  pushTool(
    'assign_worker',
    'Assign a worker to a task in the mission workspace.',
    Type.Object({
      taskId: Type.String(),
      additionalContext: Type.Optional(Type.String()),
    }),
  )
  pushTool(
    'assign_reviewer',
    'Assign a reviewer to the current task diff.',
    Type.Object({ taskId: Type.String() }),
  )
  pushTool(
    'create_task',
    'Create a new task for the backlog.',
    Type.Object({
      description: Type.String(),
      type: Type.Optional(taskTypeSchema),
      priority: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
      context: Type.Optional(Type.String()),
    }),
  )
  pushTool(
    'update_task',
    'Update a task with a partial patch.',
    Type.Object({
      taskId: Type.String(),
      patch: Type.Record(Type.String(), Type.Any()),
    }),
  )
  pushTool('cancel_task', 'Cancel a task.', Type.Object({ taskId: Type.String() }))
  pushTool(
    'retry_task',
    'Retry a failed task.',
    Type.Object({
      taskId: Type.String(),
      additionalContext: Type.Optional(Type.String()),
    }),
  )
  pushTool(
    'commit_current_task',
    'Commit the current task changes in the mission workspace.',
    Type.Object({}),
  )
  pushTool(
    'complete_mission',
    'Merge the mission branch into the integration branch and clean up mission workspace state.',
    Type.Object({}),
  )
  pushTool(
    'ask_human',
    'Ask a human question and persist it for later answer.',
    Type.Object({
      question: Type.String(),
      options: Type.Optional(Type.Array(Type.String())),
    }),
  )

  return toolDefs
}

function asPiToolResult(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    details: value,
  }
}

export function buildManagerSystemPrompt(): string {
  return [
    'You are the mission orchestration agent for this repository.',
    'Use only the provided ManagerTools tools.',
    'All newly created task descriptions must be written in Simplified Chinese.',
    'Mission mode constraints:',
    '1. Single mission only.',
    '2. Exactly one mission worktree/branch.',
    '3. Exactly one active agent at a time.',
    '4. The current task must finish review and commit before the next task starts.',
    '5. All code changes for the mission must stay inside the current mission worktree on the mission branch.',
    '6. Do not commit task changes before reviewer approval.',
    '7. Review approval only unlocks a task-level commit on the mission branch. Do not merge mission work into main/manager/develop during task execution.',
    '8. Merge is only a mission-completion action and must never happen as part of an in-flight task cycle.',
    '9. Once there are no pending/running/reviewing tasks left, complete the mission instead of launching a new inspector pass.',
    '10. If there are new human messages, address them directly in your summary and take tool actions only when appropriate.',
    'Be concise and tool-driven.',
  ].join('\n')
}

export function buildManagerPrompt(context: ManagerRuntimeContext, sessionHints: string[]): string {
  const pendingQuestions =
    context.managerState.pendingQuestions
      .filter((question) => !question.answered)
      .map((question) => `- [${question.id}] ${question.question}`)
      .join('\n') || 'none'

  const userMessages =
    context.userMessages.map((message) => `- [${message.id}] ${message.text}`).join('\n') || 'none'

  const tasksByStatus = groupTaskCounts(context.tasks)
  const taskSummary =
    Object.entries(tasksByStatus)
      .map(([status, count]) => `- ${status}: ${count}`)
      .join('\n') || '- none'

  const recentHistory =
    context.recentHistory
      .slice(-8)
      .map((entry) => `- ${entry.timestamp} ${entry.type}: ${entry.summary}`)
      .join('\n') || '- none'

  const hintBlock =
    sessionHints.length > 0
      ? sessionHints
          .slice(-8)
          .map((hint) => `- ${hint}`)
          .join('\n')
      : 'none'

  return [
    `Mission: ${context.mission}`,
    `Current stage: ${context.managerState.currentStage}`,
    `Current task: ${context.managerState.currentTaskId || 'none'}`,
    `Mission branch: ${context.managerState.missionBranch || 'unset'}`,
    `Mission worktree: ${context.managerState.missionWorktree || 'unset'}`,
    'Execution policy:',
    '- All implementation changes must stay on the mission branch inside the mission worktree.',
    '- Only call commit_current_task after reviewer approval and only for the current reviewed task.',
    '- If no pending/running/reviewing tasks remain, call complete_mission instead of launching inspector.',
    '- Do not merge to main/manager/develop while the mission is still running.',
    '- Any newly created task description must be in Simplified Chinese.',
    'Task summary:',
    taskSummary,
    'Pending human questions:',
    pendingQuestions,
    'New human messages:',
    userMessages,
    'Recent history:',
    recentHistory,
    'Session hints:',
    hintBlock,
  ].join('\n')
}

function groupTaskCounts(tasks: Task[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1
    return acc
  }, {})
}

function buildSessionSummary(
  context: ManagerRuntimeContext,
  toolCalls: string[],
  sessionHints: string[],
): string {
  return [
    `mission=${context.mission}`,
    `stage=${context.managerState.currentStage}`,
    `currentTask=${context.managerState.currentTaskId || 'none'}`,
    `toolCalls=${toolCalls.join(',') || 'none'}`,
    `hints=${sessionHints.slice(-5).join(' | ') || 'none'}`,
  ].join('\n')
}
