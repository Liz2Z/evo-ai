import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type AgentHandle, createAgentHandle, parseInspectorTasksSummary } from '../agents/launcher'
import { getControlFilePath, getHealthFilePath } from '../runtime/paths'
import type { Config, ManagerState, Question, ReviewResult, Task, TaskResult } from '../types'
import type {
  HeartbeatTickEvent,
  LogMessageEvent,
  ManagerActivityEvent,
  ManagerStateEvent,
  TaskStatusChangeEvent,
  WorktreeChangeEvent,
} from '../types/events'
import {
  commitAllChanges,
  deleteBranch,
  ensureMissionWorkspace,
  getUncommittedDiff,
  getWorktreeMissionAssociations,
  hasUncommittedChanges,
  listWorktrees,
  mergeBranchIntoBase,
  removeWorktree,
  runGit,
  validateMissionWorkspaceBranch,
} from '../utils/git'
import { addToGlobalBuffer, appendTaskLog, clearTaskLogBuffer, Logger } from '../utils/logger'
import {
  addFailedTask,
  addHistoryEntry,
  addMissionHistoryEntry,
  addQuestion,
  addTask,
  enqueueManagerUserMessage,
  loadAgents,
  loadFailedTasks,
  loadHistory,
  loadManagerState,
  loadMissionHistory,
  loadTasks,
  type MissionHistoryEntry,
  saveAgents,
  saveFailedTasks,
  saveManagerState,
  saveTasks,
  updateMissionHistoryEntry,
  updateTask as updateTaskStorage,
} from '../utils/storage'
import { hasChineseCharacters } from '../utils/task-text'
import {
  type CommitTaskResult,
  type CompleteMissionResult,
  createManagerRuntime,
  type ManagerRuntime,
  type ManagerRuntimeContext,
  type ManagerTools,
  type MissionWorkspaceResult,
  type ReviewerAssignmentResult,
  type WorkerAssignmentResult,
} from './runtime'
import { sanitizeInspectorTasks } from './task-sanitizer'
import {
  askHuman,
  assignReviewer as assignReviewerTool,
  assignWorker as assignWorkerTool,
  cancelTaskTool,
  commitCurrentTaskTool,
  completeMissionTool,
  createTask as createTaskTool,
  ensureMissionWorkspace as ensureMissionWorkspaceTool,
  getCurrentTaskDiff,
  getManagerSnapshot,
  getRecentHistory,
  getTask as getTaskTool,
  listAgents,
  listTasks,
  retryTask,
  launchInspector as launchInspectorTool,
  updateTask as updateTaskTool,
} from './tools'

interface ManagerOptions {
  runtimeFactory?: (config: Config, state: ManagerState) => ManagerRuntime
}

function createInitialState(config: Config, mission: string): ManagerState {
  return {
    mission,
    currentPhase: 'initializing',
    lastHeartbeat: '',
    lastInspection: '',
    activeSince: new Date().toISOString(),
    pendingQuestions: [],
    runtimeMode: config.manager.runtimeMode,
    lastDecisionAt: '',
    turnStatus: 'idle',
    skippedWakeups: 0,
    currentStage: 'idle',
    pendingUserMessages: [],
  }
}

export class Manager extends EventEmitter {
  private static readonly STARTUP_TURN_DELAY_MS = 25
  private readonly config: Config
  private readonly options?: ManagerOptions
  private state: ManagerState
  private activeAgents = 0
  private isRunning = false
  private isPaused = false
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private currentTurn: {
    reason: string
    interrupted: boolean
    promise: Promise<void>
  } | null = null
  private readonly pendingTurnReasons = new Set<string>()
  private readonly activeAgentHandles = new Map<string, AgentHandle>()
  private readonly tools: ManagerTools
  private runtime: ManagerRuntime
  private readonly logger: Logger

  constructor(config: Config, mission: string, options?: ManagerOptions) {
    super()
    this.config = { ...config, maxConcurrency: 1 }
    this.options = options
    this.state = createInitialState(this.config, mission)
    this.runtime = this.createRuntime(this.state)
    this.tools = this.createTools()
    this.logger = new Logger('Manager')
  }

  async start(): Promise<void> {
    this.isRunning = true

    const savedState = await loadManagerState()
    const tasks = await loadTasks()

    if (
      savedState.mission &&
      this.state.mission &&
      savedState.mission !== this.state.mission &&
      (Boolean(savedState.missionWorktree) || Boolean(savedState.currentTaskId) || tasks.length > 0)
    ) {
      this.logger.warn(
        `Saved mission differs from requested mission. Using saved: ${savedState.mission}`,
      )
      this.state.mission = savedState.mission
    }

    this.state = {
      ...createInitialState(this.config, this.state.mission || savedState.mission || ''),
      ...savedState,
      mission: this.state.mission || savedState.mission,
      runtimeMode: this.config.manager.runtimeMode,
      turnStatus: savedState.turnStatus || 'idle',
      skippedWakeups: savedState.skippedWakeups || 0,
      currentStage: savedState.currentStage || 'idle',
      pendingUserMessages: savedState.pendingUserMessages || [],
    }
    this.isPaused = this.state.turnStatus === 'paused' || this.state.currentPhase === 'paused'
    this.runtime = this.createRuntime(this.state)

    await this.recoverStaleRuntimeState()
    await this.cleanupStaleWorktrees()
    await this.refreshActiveAgents()
    await this.ensureMissionWorkspaceReady()

    this.clearControlFile()
    this.state.currentPhase = this.isPaused ? 'paused' : 'idle'
    this.state.turnStatus = this.isPaused ? 'paused' : 'idle'
    await saveManagerState(this.state)

    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'decision',
      summary: `Manager started with mission: ${this.state.mission} (mode=${this.config.manager.runtimeMode})`,
    })

    await this.runtime.init(await this.buildRuntimeContext('startup'), this.tools)
    this.emitManagerState()
    this.writeHealthFile()
    this.scheduleHeartbeat()
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (this.isRunning) {
        void this.requestTurn('startup')
      }
    }, Manager.STARTUP_TURN_DELAY_MS)
  }

  async stop(): Promise<void> {
    this.isRunning = false
    this.state.currentPhase = 'stopped'
    this.state.turnStatus = 'idle'

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }

    if (this.currentTurn) {
      this.currentTurn.interrupted = true
      await this.runtime.cancelCurrentTurn?.()
      await this.currentTurn.promise.catch(() => {})
    }

    const activeHandles = [...this.activeAgentHandles.values()]
    this.activeAgentHandles.clear()
    await Promise.allSettled(activeHandles.map((handle) => handle.cancel()))

    try {
      await this.runtime.dispose()
    } finally {
      await saveManagerState(this.state)
    }
  }

  pause(): void {
    this.isPaused = true
    this.state.currentPhase = 'paused'
    this.state.turnStatus = 'paused'
    this.writeHealthFile()
    void saveManagerState(this.state)
    this.emitManagerState()
  }

  resume(): void {
    this.isPaused = false
    this.state.currentPhase = 'idle'
    this.state.turnStatus = 'idle'
    this.writeHealthFile()
    void saveManagerState(this.state)
    this.emitManagerState()
    void this.requestTurn('resume')
  }

  async sendMessageToManager(text: string): Promise<void> {
    const content = text.trim()
    if (!content) {
      throw new Error('Message cannot be empty')
    }

    await enqueueManagerUserMessage(content)
    const persisted = await loadManagerState()
    this.state.pendingUserMessages = persisted.pendingUserMessages || []

    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'decision',
      summary: `Human message sent to manager: ${content.slice(0, 100)}`,
      details: { pendingMessages: this.state.pendingUserMessages.length },
    })

    this.emitManagerState()
    await this.requestTurn('user_message')
  }

  async addTaskManually(
    description: string,
    type: Task['type'] = 'other',
    priority = 3,
  ): Promise<Task> {
    const task: Task = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      type,
      status: 'pending',
      priority,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 0,
      maxAttempts: this.config.maxRetryAttempts,
      reviewHistory: [],
    }

    await addTask(task)
    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'task_created',
      taskId: task.id,
      summary: `Task created manually: ${description.slice(0, 100)}`,
    })
    return task
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = await updateTaskStorage(taskId, { status: 'failed' })
    if (task && this.state.currentTaskId === taskId) {
      this.state.currentTaskId = undefined
      this.state.currentStage = 'idle'
      await saveManagerState(this.state)
      this.emitManagerState()
    }
    if (task) {
      clearTaskLogBuffer(taskId)
    }
    return task !== null
  }

  getState(): ManagerState {
    return { ...this.state }
  }

  async setMission(mission: string, force = false): Promise<void> {
    const trimmed = mission.trim()
    if (!trimmed) {
      throw new Error('Mission cannot be empty')
    }

    if (this.state.mission && this.state.mission !== trimmed) {
      const tasks = await loadTasks()
      const hasActiveState =
        tasks.length > 0 || this.state.missionWorktree || this.state.currentTaskId

      if (hasActiveState && !force) {
        throw new Error(
          `Mission has active work. Use /mission --force to switch. Current: ${this.state.mission}`,
        )
      }

      if (hasActiveState && force) {
        await this.cleanupCurrentMission()
      }

      await updateMissionHistoryEntry(this.state.mission, {
        endedAt: new Date().toISOString(),
      })
    }

    const oldMission = this.state.mission
    await this.resetMissionRuntimeState()
    this.state.mission = trimmed
    await saveManagerState(this.state)
    this.emitManagerState()

    await addMissionHistoryEntry({
      mission: trimmed,
      startedAt: new Date().toISOString(),
      worktreeBranch: this.state.missionBranch,
      taskCount: (await loadTasks()).length,
    })

    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'decision',
      summary: `Mission switched to: ${trimmed}${oldMission ? ` (from: ${oldMission})` : ''}`,
    })

    if (this.isRunning) {
      await this.requestTurn('mission_switched')
    }
  }

  private async resetMissionRuntimeState(): Promise<void> {
    await saveTasks([])
    await saveFailedTasks([])

    this.state.currentTaskId = undefined
    this.state.currentStage = 'idle'
    this.state.lastInspection = ''
    this.state.pendingQuestions = []
    this.state.runtimeSessionSummary = undefined
    this.state.skippedWakeups = 0
    this.state.lastSkippedTriggerReason = undefined
    this.state.pendingUserMessages = []
    this.state.activeSince = new Date().toISOString()
  }

  private async cleanupCurrentMission(): Promise<void> {
    const tasks = await loadTasks()

    this.logger.info('Cleaning up current mission before switch...')

    if (this.state.currentTaskId) {
      this.logger.info(`Abandoning current task: ${this.state.currentTaskId}`)
      await updateTaskStorage(this.state.currentTaskId, { status: 'failed' })
      clearTaskLogBuffer(this.state.currentTaskId)
      this.state.currentTaskId = undefined
    }

    const worktreeToRemove = this.state.missionWorktree
    const branchToRemove = this.state.missionBranch

    if (worktreeToRemove && branchToRemove) {
      const associations = await getWorktreeMissionAssociations(worktreeToRemove, {
        excludeMission: this.state.mission,
      })
      if (associations.length > 0) {
        const missions = [...new Set(associations.map((entry) => entry.mission))].join(', ')
        this.logger.info(
          `Skipping mission worktree removal because it is still associated with mission(s): ${missions}`,
        )
      } else {
        this.logger.info(`Removing mission worktree: ${worktreeToRemove}`)
        let removed = await removeWorktree(worktreeToRemove, { allowAssociated: true })
        if (!removed && existsSync(worktreeToRemove)) {
          await runGit(['worktree', 'prune'])
          removed = await removeWorktree(worktreeToRemove, { allowAssociated: true })
        }
        if (!removed && existsSync(worktreeToRemove)) {
          const managedRoot = resolve(process.cwd(), this.config.worktreesDir)
          const resolvedWorktreePath = resolve(worktreeToRemove)
          if (
            resolvedWorktreePath.startsWith(`${managedRoot}/`) ||
            resolvedWorktreePath === managedRoot
          ) {
            await rm(resolvedWorktreePath, { recursive: true, force: true })
            await runGit(['worktree', 'prune'])
          }
        }
        await deleteBranch(branchToRemove)
      }

      this.state.missionWorktree = undefined
      this.state.missionBranch = undefined

      this.emit('worktree:change', {
        mission: this.state.mission,
        action: 'removed',
        path: worktreeToRemove,
        branch: branchToRemove,
      } satisfies WorktreeChangeEvent)
    }

    for (const task of tasks) {
      if (['pending', 'running', 'reviewing'].includes(task.status)) {
        await updateTaskStorage(task.id, { status: 'failed' })
        clearTaskLogBuffer(task.id)
      }
    }

    this.state.currentStage = 'idle'
    this.state.turnStatus = 'idle'
    this.state.currentPhase = 'idle'

    await saveManagerState(this.state)

    this.logger.info('Mission cleanup completed')
  }

  async getMissionHistory(): Promise<MissionHistoryEntry[]> {
    return await loadMissionHistory()
  }

  private createRuntime(state: ManagerState): ManagerRuntime {
    if (this.options?.runtimeFactory) {
      return this.options.runtimeFactory(this.config, state)
    }
    return createManagerRuntime(this.config.manager.runtimeMode, this.config, state)
  }

  private createTools(): ManagerTools {
    return {
      get_manager_snapshot: async () =>
        getManagerSnapshot(this.state, this.refreshActiveAgents.bind(this), this.activeAgents),
      list_tasks: async (input) => listTasks(input),
      list_agents: async () => listAgents(),
      get_task: async ({ taskId }) => getTaskTool({ taskId }),
      get_recent_history: async (input) => getRecentHistory(input),
      get_current_task_diff: async () => getCurrentTaskDiff(this.state.missionWorktree),
      ensure_mission_workspace: async () =>
        ensureMissionWorkspaceTool({ ensureMissionWorkspaceReady: this.ensureMissionWorkspaceReady.bind(this) }),
      launch_inspector: async ({ reason }) =>
        launchInspectorTool(
          { reason },
          {
            refreshActiveAgents: this.refreshActiveAgents.bind(this),
            activeAgents: this.activeAgents,
            currentTaskId: this.state.currentTaskId,
            loadTasks,
            setState: async (updates) => {
              Object.assign(this.state, updates)
              await saveManagerState(this.state)
            },
            emitManagerState: this.emitManagerState.bind(this),
            incrementActiveAgents: () => {
              this.activeAgents++
            },
            getRecentDecisions: this.getRecentDecisions.bind(this),
            createAgentHandle: (config: any) => createAgentHandle(config),
            activeAgentHandles: this.activeAgentHandles,
            addHistoryEntry,
            sanitizeInspectorTasks,
            parseInspectorTasksFromResult: this.parseInspectorTasksFromResult.bind(this),
            addTask,
            requestTurn: this.requestTurn.bind(this),
            logger: this.logger,
            state: this.state,
          },
        ),
      assign_worker: async ({ taskId, additionalContext }) =>
        assignWorkerTool(
          { taskId, additionalContext },
          {
            getTaskById: this.getTaskById.bind(this),
            ensureMissionWorkspaceReady: this.ensureMissionWorkspaceReady.bind(this),
            updateTask: updateTaskStorage,
            setState: async (updates) => {
              Object.assign(this.state, updates)
              await saveManagerState(this.state)
            },
            emitTaskStatusChange: this.emitTaskStatusChange.bind(this),
            emitManagerState: this.emitManagerState.bind(this),
            incrementActiveAgents: () => {
              this.activeAgents++
            },
            getRecentDecisions: this.getRecentDecisions.bind(this),
            createAgentHandle: (config: any) => createAgentHandle(config),
            activeAgentHandles: this.activeAgentHandles,
            requestTurn: this.requestTurn.bind(this),
            handleWorkerResult: this.handleWorkerResult.bind(this),
            failTask: this.failTask.bind(this),
            activeAgents: this.activeAgents,
            state: this.state,
          },
        ),
      assign_reviewer: async ({ taskId }) =>
        assignReviewerTool(
          { taskId },
          {
            getTaskById: this.getTaskById.bind(this),
            validateMissionWorktree: this.validateMissionWorktree.bind(this),
            setState: async (updates) => {
              Object.assign(this.state, updates)
              await saveManagerState(this.state)
            },
            emitManagerState: this.emitManagerState.bind(this),
            incrementActiveAgents: () => {
              this.activeAgents++
            },
            getRecentDecisions: this.getRecentDecisions.bind(this),
            createAgentHandle: (config: any) => createAgentHandle(config),
            activeAgentHandles: this.activeAgentHandles,
            requestTurn: this.requestTurn.bind(this),
            handleReviewResult: this.handleReviewResult.bind(this),
            failTask: this.failTask.bind(this),
            activeAgents: this.activeAgents,
            state: this.state,
          },
        ),
      create_task: async ({ description, type = 'other', priority = 3, context }) =>
        createTaskTool({ description, type, priority, context }, {
          addTaskManually: this.addTaskManually.bind(this),
          updateTask: updateTaskStorage,
        }),
      update_task: async ({ taskId, patch }) => updateTaskTool({ taskId, patch }),
      cancel_task: async ({ taskId }) =>
        cancelTaskTool({ taskId }, { cancelTask: this.cancelTask.bind(this) }),
      retry_task: async ({ taskId, additionalContext }) =>
        retryTask({ taskId, additionalContext }, { getTaskById: this.getTaskById.bind(this) }),
      commit_current_task: async () =>
        commitCurrentTaskTool(undefined, { commitCurrentTask: this.commitCurrentTask.bind(this) }),
      complete_mission: async () =>
        completeMissionTool(undefined, { completeMission: this.completeMission.bind(this) }),
      ask_human: async ({ question, options }) =>
        askHuman(
          { question, options },
          {
            state: this.state,
            setState: async (updates) => {
              Object.assign(this.state, updates)
              await saveManagerState(this.state)
            },
          },
        ),
    }
  }

  private scheduleHeartbeat(): void {
    if (!this.isRunning) return
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
    }
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null
      void this.runHeartbeatTurn()
    }, this.config.heartbeatInterval)
  }

  private async runHeartbeatTurn(): Promise<void> {
    if (!this.isRunning) return
    await this.requestTurn('heartbeat')
    if (!this.isRunning) return
    this.scheduleHeartbeat()
  }

  private async requestTurn(reason: string): Promise<void> {
    if (!this.isRunning) return

    if (this.runtime.onExternalEvent) {
      await this.runtime.onExternalEvent({ reason, timestamp: new Date().toISOString() })
    }

    if (this.currentTurn) {
      if (reason === 'user_message' && this.currentTurn.reason === 'heartbeat') {
        this.pendingTurnReasons.delete('heartbeat')
        this.pendingTurnReasons.add('user_message')
        this.currentTurn.interrupted = true
        this.emitManagerActivity({
          timestamp: new Date().toISOString(),
          triggerReason: reason,
          summary: 'interrupting heartbeat for user message',
          toolCalls: [],
          kind: 'turn_interrupted',
        })
        await this.runtime.cancelCurrentTurn?.()
      } else {
        this.pendingTurnReasons.add(reason)
        if (reason !== 'user_message') {
          this.state.skippedWakeups += 1
          this.state.lastSkippedTriggerReason = reason
        }
        this.emitManagerActivity({
          timestamp: new Date().toISOString(),
          triggerReason: reason,
          summary: reason === 'user_message' ? 'queued behind active turn' : 'turn busy',
          toolCalls: [],
          kind: 'turn_skipped',
        })
        this.writeHealthFile()
        await saveManagerState(this.state)
        this.emitManagerState()
      }

      await this.currentTurn.promise
      const pendingReason = this.consumePendingTurnReason()
      if (pendingReason) {
        await this.requestTurn(pendingReason)
      }
      return
    }

    const currentTurn = {
      reason,
      interrupted: false,
      promise: Promise.resolve(),
    }
    currentTurn.promise = this.executeTurn(reason, currentTurn).finally(() => {
      if (this.currentTurn === currentTurn) {
        this.currentTurn = null
      }
    })
    this.currentTurn = currentTurn
    await currentTurn.promise
    const pendingReason = this.consumePendingTurnReason()
    if (pendingReason) {
      await this.requestTurn(pendingReason)
    }
  }

  private consumePendingTurnReason(): string | null {
    if (this.pendingTurnReasons.size === 0) return null
    if (this.pendingTurnReasons.has('user_message')) {
      this.pendingTurnReasons.delete('user_message')
      return 'user_message'
    }
    const reasons = [...this.pendingTurnReasons]
    this.pendingTurnReasons.clear()
    if (reasons.length === 1) return reasons[0]
    return `queued:${reasons.join('+')}`
  }

  private async executeTurn(
    reason: string,
    currentTurn: { reason: string; interrupted: boolean },
  ): Promise<void> {
    this.checkControlFile()
    if (!this.isRunning) return

    await this.syncPersistedStateFields()
    if (this.isPaused) {
      this.state.currentPhase = 'paused'
      this.state.turnStatus = 'paused'
      this.writeHealthFile()
      await saveManagerState(this.state)
      this.emitManagerState()
      return
    }

    await this.refreshActiveAgents()

    this.state.lastHeartbeat = new Date().toISOString()
    this.state.currentPhase = 'running'
    this.state.turnStatus = 'running'
    const consumedUserMessageIds = new Set(
      (this.state.pendingUserMessages || []).map((message) => message.id),
    )
    this.emitManagerActivity({
      timestamp: this.state.lastHeartbeat,
      triggerReason: reason,
      summary: `trigger=${reason}`,
      toolCalls: [],
      kind: 'turn_started',
    })
    this.writeHealthFile()
    this.emitManagerState()

    const tasks = await loadTasks()
    this.emit('heartbeat', {
      timestamp: this.state.lastHeartbeat,
      phase: this.state.currentPhase,
      activeAgents: this.activeAgents,
      pendingCount: tasks.filter((task) => task.status === 'pending').length,
    } satisfies HeartbeatTickEvent)

    try {
      const context = await this.buildRuntimeContext(reason)
      const result = await this.runtime.runTurn(context, this.tools)
      this.emitManagerActivity({
        timestamp: new Date().toISOString(),
        triggerReason: reason,
        summary: result.summary,
        toolCalls: result.toolCalls,
        kind: 'turn_completed',
      })

      this.state.lastDecisionAt = new Date().toISOString()
      if (result.sessionSummary !== undefined) {
        this.state.runtimeSessionSummary = result.sessionSummary
      }
      const persisted = await loadManagerState()
      this.state.pendingUserMessages = (persisted.pendingUserMessages || []).filter(
        (message) => !consumedUserMessageIds.has(message.id),
      )

      await this.handleFailedTasks()
      await addHistoryEntry({
        timestamp: this.state.lastDecisionAt,
        type: 'decision',
        summary: `Manager turn completed (${this.state.runtimeMode}, trigger=${reason}) tools=[${result.toolCalls.join(', ') || 'none'}]`,
        details: {
          summary: result.summary,
          unauthorizedToolCalls: result.unauthorizedToolCalls,
        },
      })
    } catch (error) {
      if (currentTurn.interrupted) {
        this.emitManagerActivity({
          timestamp: new Date().toISOString(),
          triggerReason: reason,
          summary: `turn interrupted: ${reason}`,
          toolCalls: [],
          kind: 'turn_interrupted',
        })
        return
      }

      this.emitManagerActivity({
        timestamp: new Date().toISOString(),
        triggerReason: reason,
        summary: error instanceof Error ? error.message : String(error),
        toolCalls: [],
        kind: 'turn_failed',
      })
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'error',
        summary: `Manager turn failed: ${error}`,
      })
    } finally {
      await this.refreshActiveAgents()
      this.state.currentPhase = 'idle'
      this.state.turnStatus = 'idle'
      this.writeHealthFile()
      await saveManagerState(this.state)
      this.emitManagerState()
    }
  }

  private async buildRuntimeContext(triggerReason: string): Promise<ManagerRuntimeContext> {
    const [tasks, agents, history] = await Promise.all([loadTasks(), loadAgents(), loadHistory()])
    return {
      triggerReason,
      timestamp: new Date().toISOString(),
      mission: this.state.mission,
      config: this.config,
      managerState: this.getState(),
      tasks,
      agents,
      recentHistory: history.slice(-20),
      userMessages: this.state.pendingUserMessages || [],
    }
  }

  private async refreshActiveAgents(): Promise<void> {
    const agents = await loadAgents()
    this.activeAgents = agents.filter((agent) => agent.status === 'busy').length
  }

  private async syncPersistedStateFields(): Promise<void> {
    const persisted = await loadManagerState()
    if (persisted.mission) this.state.mission = persisted.mission
    this.state.pendingQuestions = persisted.pendingQuestions || []
    this.state.pendingUserMessages = persisted.pendingUserMessages || []
    this.state.missionBranch = persisted.missionBranch
    this.state.missionWorktree = persisted.missionWorktree
    this.state.currentTaskId = persisted.currentTaskId
    this.state.currentStage = persisted.currentStage || this.state.currentStage
  }

  private async getTaskById(taskId: string): Promise<Task | null> {
    const tasks = await loadTasks()
    return tasks.find((task) => task.id === taskId) || null
  }

  private async ensureMissionWorkspaceReady(): Promise<MissionWorkspaceResult> {
    const existingWorktreePath = this.validateMissionWorktree()
    if (existingWorktreePath && this.state.missionBranch) {
      const validation = await validateMissionWorkspaceBranch(
        existingWorktreePath,
        this.state.missionBranch,
      )
      if (!validation.valid) {
        return {
          status: 'failed',
          path: existingWorktreePath,
          branch: this.state.missionBranch,
          message: validation.message,
        }
      }

      await updateMissionHistoryEntry(this.state.mission, {
        worktreeBranch: this.state.missionBranch,
        worktreePath: existingWorktreePath,
      })
      return {
        status: 'ready',
        path: existingWorktreePath,
        branch: this.state.missionBranch,
        message: 'Mission workspace already ready',
      }
    }

    const workspace = await ensureMissionWorkspace(
      this.state.mission,
      this.config.developBranch,
      this.config.worktreesDir,
    )
    if (!workspace) {
      return { status: 'failed', message: 'Failed to create mission workspace' }
    }

    this.state.missionWorktree = workspace.path
    this.state.missionBranch = workspace.branch
    await saveManagerState(this.state)
    await updateMissionHistoryEntry(this.state.mission, {
      worktreeBranch: workspace.branch,
      worktreePath: workspace.path,
    })
    this.emit('worktree:change', {
      mission: this.state.mission,
      action: 'created',
      path: workspace.path,
      branch: workspace.branch,
    } satisfies WorktreeChangeEvent)
    this.emitManagerState()

    return {
      status: 'ready',
      path: workspace.path,
      branch: workspace.branch,
      message: 'Mission workspace ready',
    }
  }

  private async launchInspector(
    reason: string,
  ): Promise<{ status: 'started' | 'noop'; createdTaskIds: string[]; message: string }> {
    await this.refreshActiveAgents()
    const tasks = await loadTasks()
    const hasActiveQueue = tasks.some((task) =>
      ['pending', 'running', 'reviewing'].includes(task.status),
    )
    if (this.activeAgents > 0 || this.state.currentTaskId || hasActiveQueue) {
      return { status: 'noop', createdTaskIds: [], message: 'Mission queue is not idle' }
    }

    this.state.currentStage = 'inspecting'
    await saveManagerState(this.state)
    this.emitManagerState()
    this.activeAgents++

    const recentDecisions = await this.getRecentDecisions()
    const launcher = createAgentHandle({
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
      mission: this.state.mission,
      recentDecisions,
      onError: (error) => this.logger.error(`Inspector failed: ${error}`),
    })
    this.activeAgentHandles.set('inspection', launcher)

    void launcher
      .start()
      .then(() => launcher.execute())
      .then(async (newTasks) => {
        this.activeAgentHandles.delete('inspection')
        const existingTasks = await loadTasks()
        const rawTasks =
          newTasks && 'summary' in newTasks
            ? this.parseInspectorTasksFromResult(newTasks.summary, this.state.mission)
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
          this.logger.info(
            `Dropped inspector task (${item.reason}): ${item.task.description.slice(0, 120)}`,
          )
        }

        this.state.lastInspection = new Date().toISOString()
        this.state.currentStage = 'idle'
        this.activeAgents = Math.max(0, this.activeAgents - 1)
        await saveManagerState(this.state)
        this.emitManagerState()
        await this.requestTurn(`inspector_completed:${reason}`)
      })
      .catch(async (error) => {
        this.activeAgentHandles.delete('inspection')
        this.activeAgents = Math.max(0, this.activeAgents - 1)
        this.state.currentStage = 'idle'
        await addHistoryEntry({
          timestamp: new Date().toISOString(),
          type: 'error',
          summary: `Inspector failed: ${error}`,
        })
        await saveManagerState(this.state)
        this.emitManagerState()
        await this.requestTurn('inspector_failed')
      })

    return { status: 'started', createdTaskIds: [], message: `Inspector launched (${reason})` }
  }

  private async assignWorker(task: Task, additionalContext = ''): Promise<WorkerAssignmentResult> {
    const freshTask = await this.getTaskById(task.id)
    if (!freshTask) {
      return { status: 'not_found', taskId: task.id, message: 'Task not found' }
    }
    if (!['pending', 'running'].includes(freshTask.status)) {
      return { status: 'noop', taskId: task.id, message: `Task is ${freshTask.status}` }
    }
    if (this.activeAgents > 0) {
      return { status: 'noop', taskId: task.id, message: 'Another agent is already active' }
    }

    const workspace = await this.ensureMissionWorkspaceReady()
    if (workspace.status === 'failed' || !workspace.path) {
      return { status: 'noop', taskId: task.id, message: workspace.message }
    }

    const beforeStatus = freshTask.status
    await updateTaskStorage(freshTask.id, { status: 'running' })
    this.state.currentTaskId = freshTask.id
    this.state.currentStage = 'working'
    await saveManagerState(this.state)
    this.emitTaskStatusChange(freshTask.id, beforeStatus, 'running', {
      ...freshTask,
      status: 'running',
    })
    this.emitManagerState()

    this.activeAgents++
    const recentDecisions = await this.getRecentDecisions()
    const onLog = (event: LogMessageEvent) => this.handleLogEvent(event)
    const launcher = createAgentHandle({
      type: 'worker',
      task: { ...freshTask, status: 'running' },
      mission: this.state.mission,
      recentDecisions,
      additionalContext,
      worktreePath: workspace.path,
      onLog,
    })
    this.activeAgentHandles.set(freshTask.id, launcher)

    void launcher
      .start()
      .then(() => launcher.execute())
      .then(async (result) => {
        this.activeAgentHandles.delete(freshTask.id)
        if (result) {
          await this.handleWorkerResult(freshTask.id, result as TaskResult)
        } else {
          await this.failTask(freshTask.id, 'Worker returned no result')
        }
        this.activeAgents = Math.max(0, this.activeAgents - 1)
        await this.requestTurn(`worker_completed:${freshTask.id}`)
      })
      .catch(async (error) => {
        this.activeAgentHandles.delete(freshTask.id)
        await this.failTask(freshTask.id, error instanceof Error ? error.message : String(error))
        this.activeAgents = Math.max(0, this.activeAgents - 1)
        await this.requestTurn(`worker_failed:${freshTask.id}`)
      })

    return { status: 'started', taskId: freshTask.id, message: 'Worker assigned' }
  }

  private async handleWorkerResult(taskId: string, result: TaskResult): Promise<void> {
    const latestTask = await this.getTaskById(taskId)
    if (!latestTask) return

    if (result.status === 'completed') {
      await updateTaskStorage(taskId, { status: 'reviewing' })
      this.state.currentTaskId = taskId
      this.state.currentStage = 'reviewing'
      await saveManagerState(this.state)
      this.emitTaskStatusChange(taskId, latestTask.status, 'reviewing', {
        ...latestTask,
        status: 'reviewing',
      })
      this.emitManagerState()
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'decision',
        taskId,
        summary: `Task implementation finished: ${result.summary.slice(0, 100)}`,
        details: { filesChanged: result.filesChanged },
      })
      return
    }

    await this.failTask(taskId, result.error || result.summary)
  }

  private async assignReviewer(task: Task): Promise<ReviewerAssignmentResult> {
    const freshTask = await this.getTaskById(task.id)
    if (!freshTask) {
      return { status: 'not_found', taskId: task.id, message: 'Task not found' }
    }
    if (freshTask.status !== 'reviewing') {
      return { status: 'noop', taskId: task.id, message: `Task is ${freshTask.status}` }
    }
    const worktreePath = this.validateMissionWorktree()
    if (!worktreePath) {
      return { status: 'noop', taskId: task.id, message: 'Mission workspace is missing or invalid' }
    }
    if (this.activeAgents > 0) {
      return { status: 'noop', taskId: task.id, message: 'Another agent is already active' }
    }

    const diff = await getUncommittedDiff(worktreePath)
    if (!diff.trim()) {
      await this.failTask(task.id, 'No diff to review in mission workspace')
      return { status: 'noop', taskId: task.id, message: 'No diff to review' }
    }

    this.state.currentTaskId = task.id
    this.state.currentStage = 'reviewing'
    await saveManagerState(this.state)
    this.emitManagerState()

    this.activeAgents++
    const recentDecisions = await this.getRecentDecisions()
    const onLog = (event: LogMessageEvent) => this.handleLogEvent(event)
    const launcher = createAgentHandle({
      type: 'reviewer',
      task,
      mission: this.state.mission,
      recentDecisions,
      additionalContext: `## Code Changes to Review\n\`\`\`diff\n${diff}\n\`\`\``,
      worktreePath,
      onLog,
    })
    this.activeAgentHandles.set(task.id, launcher)

    void launcher
      .start()
      .then(() => launcher.execute())
      .then(async (result) => {
        this.activeAgentHandles.delete(task.id)
        if (result) {
          await this.handleReviewResult(task.id, result as ReviewResult)
        } else {
          await this.failTask(task.id, 'Reviewer returned no result')
        }
        this.activeAgents = Math.max(0, this.activeAgents - 1)
        await this.requestTurn(`review_completed:${task.id}`)
      })
      .catch(async (error) => {
        this.activeAgentHandles.delete(task.id)
        await this.failTask(task.id, error instanceof Error ? error.message : String(error))
        this.activeAgents = Math.max(0, this.activeAgents - 1)
        await this.requestTurn(`review_failed:${task.id}`)
      })

    return { status: 'started', taskId: task.id, message: 'Reviewer assigned' }
  }

  private async handleReviewResult(taskId: string, result: ReviewResult): Promise<void> {
    const latestTask = await this.getTaskById(taskId)
    if (!latestTask) return

    const nextAttempt = latestTask.attemptCount + 1
    const reviewEntry = {
      attempt: nextAttempt,
      agentId: 'reviewer',
      review: result,
      timestamp: new Date().toISOString(),
    }
    const reviewHistory = [...latestTask.reviewHistory, reviewEntry]

    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'review',
      taskId,
      summary: `Review: ${result.verdict} (${result.confidence}) - ${result.summary}`,
      details: { issues: result.issues, suggestions: result.suggestions },
    })

    if (result.verdict === 'approve') {
      await updateTaskStorage(taskId, {
        status: 'reviewing',
        attemptCount: nextAttempt,
        reviewHistory,
      })
      this.state.currentTaskId = taskId
      this.state.currentStage = 'committing'
      await saveManagerState(this.state)
      this.emitManagerState()
      return
    }

    if (result.verdict === 'reject' || nextAttempt >= latestTask.maxAttempts) {
      await updateTaskStorage(taskId, {
        status: 'failed',
        attemptCount: nextAttempt,
        reviewHistory,
      })
      this.state.currentTaskId = undefined
      this.state.currentStage = 'idle'
      await saveManagerState(this.state)
      this.emitTaskStatusChange(taskId, latestTask.status, 'failed', {
        ...latestTask,
        status: 'failed',
        attemptCount: nextAttempt,
        reviewHistory,
      })
      clearTaskLogBuffer(taskId)
      this.emitManagerState()
      return
    }

    const additionalContext = this.buildRetryContext(result)
    await updateTaskStorage(taskId, {
      status: 'running',
      attemptCount: nextAttempt,
      context: latestTask.context
        ? `${latestTask.context}\n\n${additionalContext}`
        : additionalContext,
      reviewHistory,
    })
    this.state.currentTaskId = taskId
    this.state.currentStage = 'working'
    await saveManagerState(this.state)
    this.emitTaskStatusChange(taskId, latestTask.status, 'running', {
      ...latestTask,
      status: 'running',
      attemptCount: nextAttempt,
      context: latestTask.context
        ? `${latestTask.context}\n\n${additionalContext}`
        : additionalContext,
      reviewHistory,
    })
    this.emitManagerState()
  }

  private buildRetryContext(result: ReviewResult): string {
    let context = '## Previous Review Feedback\n\n'
    if (result.issues.length > 0) {
      context += `Issues to fix:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}\n\n`
    }
    if (result.suggestions.length > 0) {
      context += `Suggestions:\n${result.suggestions.map((item) => `- ${item}`).join('\n')}\n\n`
    }
    context += `Summary: ${result.summary}\n`
    return context
  }

  private async commitCurrentTask(): Promise<CommitTaskResult> {
    const taskId = this.state.currentTaskId
    if (!taskId) {
      return { status: 'noop', message: 'No current task to commit' }
    }
    const worktreePath = this.validateMissionWorktree()
    if (!worktreePath) {
      return { status: 'failed', taskId, message: 'Mission workspace is missing or invalid' }
    }

    const task = await this.getTaskById(taskId)
    if (!task) {
      return { status: 'not_found', taskId, message: 'Task not found' }
    }

    if (task.status !== 'reviewing') {
      return {
        status: 'failed',
        taskId,
        message: `Current task is ${task.status}. Only reviewed tasks can be committed.`,
      }
    }

    const latestReview = task.reviewHistory[task.reviewHistory.length - 1]
    if (!latestReview || latestReview.review.verdict !== 'approve') {
      return {
        status: 'failed',
        taskId,
        message: 'Current task has not been approved by review. Commit is blocked.',
      }
    }

    if (this.state.currentStage !== 'committing') {
      return {
        status: 'failed',
        taskId,
        message: `Current stage is ${this.state.currentStage}. Commit is only allowed in committing stage.`,
      }
    }

    if (!this.state.missionBranch) {
      return { status: 'failed', taskId, message: 'Mission branch is missing' }
    }

    const branchValidation = await validateMissionWorkspaceBranch(
      worktreePath,
      this.state.missionBranch,
    )
    if (!branchValidation.valid) {
      return {
        status: 'failed',
        taskId,
        message: `${branchValidation.message}. Mission changes must stay on the mission branch until the mission is complete.`,
      }
    }

    const hasChanges = await hasUncommittedChanges(worktreePath)
    if (!hasChanges) {
      await this.failTask(taskId, 'No changes to commit for current task')
      return { status: 'failed', taskId, message: 'No changes to commit' }
    }

    this.state.currentStage = 'committing'
    await saveManagerState(this.state)
    this.emitManagerState()

    const result = await commitAllChanges(this.buildCommitMessage(task), worktreePath)
    if (!result.success) {
      await this.failTask(taskId, result.message)
      return { status: 'failed', taskId, message: result.message }
    }

    await updateTaskStorage(taskId, { status: 'completed' })
    this.state.currentTaskId = undefined
    this.state.currentStage = 'idle'
    await saveManagerState(this.state)
    this.emitTaskStatusChange(taskId, task.status, 'completed', { ...task, status: 'completed' })
    clearTaskLogBuffer(taskId)
    this.emitManagerState()
    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'task_completed',
      taskId,
      summary: `Task committed: ${this.buildCommitMessage(task)}`,
    })

    return { status: 'committed', taskId, message: result.message }
  }

  private async completeMission(): Promise<CompleteMissionResult> {
    const tasks = await loadTasks()
    const openTasks = tasks.filter((task) =>
      ['pending', 'running', 'reviewing'].includes(task.status),
    )

    if (this.activeAgents > 0 || this.state.currentTaskId) {
      return { status: 'noop', message: 'Mission still has active execution' }
    }

    if (tasks.length === 0) {
      return { status: 'noop', message: 'Mission has no tasks to complete' }
    }

    if (openTasks.length > 0) {
      return {
        status: 'noop',
        message: `Mission still has unfinished tasks: ${openTasks.map((task) => task.id).join(', ')}`,
      }
    }

    if (!this.state.missionBranch || !this.state.missionWorktree) {
      return { status: 'noop', message: 'Mission workspace already cleaned up' }
    }

    this.state.currentStage = 'integrating'
    await saveManagerState(this.state)
    this.emitManagerState()

    const mergeResult = await mergeBranchIntoBase(
      this.state.missionBranch,
      this.config.developBranch,
      process.cwd(),
    )

    if (!mergeResult.success) {
      this.state.currentStage = 'idle'
      await saveManagerState(this.state)
      this.emitManagerState()
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'error',
        summary: `Mission merge failed: ${mergeResult.message}`,
      })
      return { status: 'failed', message: mergeResult.message }
    }

    const worktreePath = this.state.missionWorktree
    const branchName = this.state.missionBranch

    await updateMissionHistoryEntry(this.state.mission, {
      endedAt: new Date().toISOString(),
      taskCount: tasks.length,
    })

    let removed = await removeWorktree(worktreePath, { allowAssociated: true })
    if (!removed && existsSync(worktreePath)) {
      await runGit(['worktree', 'prune'])
      removed = await removeWorktree(worktreePath, { allowAssociated: true })
    }
    if (!removed && existsSync(worktreePath)) {
      const managedRoot = resolve(process.cwd(), this.config.worktreesDir)
      const resolvedWorktreePath = resolve(worktreePath)
      if (
        resolvedWorktreePath.startsWith(`${managedRoot}/`) ||
        resolvedWorktreePath === managedRoot
      ) {
        await rm(resolvedWorktreePath, { recursive: true, force: true })
        await runGit(['worktree', 'prune'])
        removed = !existsSync(resolvedWorktreePath)
      }
    }
    const deleted = await deleteBranch(branchName)

    this.state.missionWorktree = undefined
    this.state.missionBranch = undefined
    this.state.currentStage = 'idle'
    await saveManagerState(this.state)
    this.emitManagerState()

    this.emit('worktree:change', {
      mission: this.state.mission,
      action: 'removed',
      path: worktreePath,
      branch: branchName,
    } satisfies WorktreeChangeEvent)

    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'decision',
      summary: `Mission merged into ${this.config.developBranch}`,
      details: {
        missionBranch: branchName,
        worktreeRemoved: removed,
        branchDeleted: deleted,
      },
    })

    return {
      status: 'merged',
      message: `Merged ${branchName} into ${this.config.developBranch}`,
    }
  }

  private buildCommitMessage(task: Task): string {
    const subject = task.description
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s\-_:/.]/gu, '')
      .trim()
      .slice(0, 72)
    return `task(${task.type}): ${subject || task.id}`
  }

  private async failTask(taskId: string, reason: string): Promise<void> {
    const latestTask = await this.getTaskById(taskId)
    if (!latestTask) return

    await updateTaskStorage(taskId, {
      status: 'failed',
      context: latestTask.context
        ? `${latestTask.context}\n\nFailure: ${reason}`
        : `Failure: ${reason}`,
    })
    this.state.currentTaskId = undefined
    this.state.currentStage = 'idle'
    await saveManagerState(this.state)
    this.emitTaskStatusChange(taskId, latestTask.status, 'failed', {
      ...latestTask,
      status: 'failed',
      context: latestTask.context
        ? `${latestTask.context}\n\nFailure: ${reason}`
        : `Failure: ${reason}`,
    })
    clearTaskLogBuffer(taskId)
    this.emitManagerState()
  }

  private async handleFailedTasks(): Promise<void> {
    const [tasks, failedTasks] = await Promise.all([loadTasks(), loadFailedTasks()])
    const failedIds = new Set(failedTasks.map((task) => task.id))
    for (const task of tasks.filter((item) => item.status === 'failed')) {
      if (failedIds.has(task.id)) continue
      await addFailedTask(task)
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'task_failed',
        taskId: task.id,
        summary: `Task failed after ${task.attemptCount} review cycle(s): ${task.description.slice(0, 100)}`,
      })
    }
  }

  private async getRecentDecisions(): Promise<string[]> {
    const history = await loadHistory()
    return history
      .filter((entry) => entry.type === 'decision')
      .slice(-5)
      .map((entry) => entry.summary)
  }

  private handleLogEvent(event: LogMessageEvent): void {
    this.emit('log:message', event)
    if (!event.taskId) return
    const entry = {
      timestamp: event.timestamp,
      agentId: event.agentId,
      taskId: event.taskId,
      source: event.source,
      level: event.level,
      message: event.message,
    } as const
    addToGlobalBuffer(event.taskId, entry)
    void appendTaskLog(event.taskId, entry)
  }

  private emitTaskStatusChange(
    taskId: string,
    fromStatus: Task['status'],
    toStatus: Task['status'],
    task: Task,
  ): void {
    this.emit('task:status_change', {
      taskId,
      fromStatus,
      toStatus,
      task,
    } satisfies TaskStatusChangeEvent)
  }

  private emitManagerState(): void {
    this.emit('manager:state', {
      phase: this.state.currentPhase,
      mission: this.state.mission,
      lastHeartbeat: this.state.lastHeartbeat,
      lastInspection: this.state.lastInspection,
      activeSince: this.state.activeSince,
      pendingQuestions: this.state.pendingQuestions,
      runtimeMode: this.state.runtimeMode,
      turnStatus: this.state.turnStatus,
      lastDecisionAt: this.state.lastDecisionAt,
      runtimeSessionSummary: this.state.runtimeSessionSummary,
      skippedWakeups: this.state.skippedWakeups,
      lastSkippedTriggerReason: this.state.lastSkippedTriggerReason,
      missionBranch: this.state.missionBranch,
      missionWorktree: this.state.missionWorktree,
      currentTaskId: this.state.currentTaskId,
      currentStage: this.state.currentStage,
      pendingUserMessages: this.state.pendingUserMessages || [],
    } satisfies ManagerStateEvent)
  }

  private emitManagerActivity(event: ManagerActivityEvent): void {
    this.emit('manager:activity', event)
  }

  private checkControlFile(): void {
    const controlFile = getControlFilePath()
    try {
      if (!existsSync(controlFile)) return
      const content = readFileSync(controlFile, 'utf-8')
      const cmd = JSON.parse(content)
      this.clearControlFile()

      if (cmd.action === 'pause') this.pause()
      else if (cmd.action === 'resume') this.resume()
      else if (cmd.action === 'stop') void this.stop()
    } catch {
      this.clearControlFile()
    }
  }

  private clearControlFile(): void {
    const controlFile = getControlFilePath()
    try {
      if (existsSync(controlFile)) unlinkSync(controlFile)
    } catch {}
  }

  private writeHealthFile(): void {
    const healthFile = getHealthFilePath()
    try {
      writeFileSync(
        healthFile,
        JSON.stringify({
          pid: process.pid,
          phase: this.state.currentPhase,
          turnStatus: this.state.turnStatus,
          runtimeMode: this.state.runtimeMode,
          isPaused: this.isPaused,
          activeAgents: this.activeAgents,
          lastHeartbeat: this.state.lastHeartbeat,
          lastDecisionAt: this.state.lastDecisionAt,
          skippedWakeups: this.state.skippedWakeups,
          lastSkippedTriggerReason: this.state.lastSkippedTriggerReason,
          heartbeatInterval: this.config.heartbeatInterval,
          currentStage: this.state.currentStage,
          currentTaskId: this.state.currentTaskId,
          missionWorktree: this.state.missionWorktree,
          pendingUserMessages: this.state.pendingUserMessages || [],
          timestamp: new Date().toISOString(),
        }),
      )
    } catch {}
  }

  private async cleanupStaleWorktrees(): Promise<void> {
    const allWorktrees = await listWorktrees()
    const activeWorktrees = new Set<string>()
    if (this.state.missionWorktree) {
      activeWorktrees.add(this.state.missionWorktree)
    }

    const worktreesDirName =
      this.config.worktreesDir.split('/').filter(Boolean).pop() || this.config.worktreesDir
    const staleWorktrees = allWorktrees.filter(
      (worktree) => worktree.includes(worktreesDirName) && !activeWorktrees.has(worktree),
    )

    for (const worktree of staleWorktrees) {
      const associations = await getWorktreeMissionAssociations(worktree)
      if (associations.length > 0) {
        const missions = [...new Set(associations.map((entry) => entry.mission))].join(', ')
        this.logger.info(
          `Skipping stale worktree cleanup because it is still associated with mission(s): ${missions}`,
        )
        continue
      }

      await removeWorktree(worktree)
    }
  }

  private async recoverStaleRuntimeState(): Promise<void> {
    const agents = await loadAgents()
    const activeTaskIds = new Set<string>()
    const activeReviewerTaskIds = new Set<string>()
    let activeBusyAgents = 0
    const recoveredAgents = agents.map((agent) => {
      const processAlive = agent.pid ? this.isProcessAlive(agent.pid) : false
      if (agent.status === 'busy' && processAlive && agent.currentTask) {
        activeBusyAgents += 1
        activeTaskIds.add(agent.currentTask)
        if (agent.type === 'reviewer') {
          activeReviewerTaskIds.add(agent.currentTask)
        }
        return agent
      }
      if (agent.status === 'busy' && processAlive) {
        activeBusyAgents += 1
        return agent
      }
      if (agent.status !== 'busy') return agent
      return {
        ...agent,
        status: 'idle' as const,
        currentTask: undefined,
        pid: undefined,
      }
    })
    if (recoveredAgents.some((agent, index) => agent !== agents[index])) {
      await saveAgents(recoveredAgents)
    }
    this.activeAgents = activeBusyAgents

    const tasks = await loadTasks()
    let changed = false
    for (const task of tasks) {
      if (task.status !== 'running' && task.status !== 'reviewing') continue
      if (activeTaskIds.has(task.id)) continue
      changed = true
      await updateTaskStorage(task.id, { status: 'pending' })
    }

    let stateChanged = false
    if (this.state.currentTaskId && !activeTaskIds.has(this.state.currentTaskId)) {
      this.state.currentTaskId = undefined
      stateChanged = true
    }

    if (!this.state.currentTaskId && this.state.currentStage !== 'idle') {
      this.state.currentStage = 'idle'
      stateChanged = true
    }

    if (changed) {
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'decision',
        summary: 'Recovered stale runtime state: reset busy agents and resumed mission pipeline',
      })
    }

    if (this.state.currentStage === 'committing' && this.state.currentTaskId) {
      if (!activeReviewerTaskIds.has(this.state.currentTaskId)) {
        this.state.currentStage = 'reviewing'
        stateChanged = true
      }
    }

    if (stateChanged) {
      await saveManagerState(this.state)
    }
  }

  private parseInspectorTasksFromResult(summary: string, mission: string): Task[] {
    const tasks = parseInspectorTasksSummary(summary)
    return tasks.length > 0 ? tasks : this.buildInspectorFallbackTasks(mission)
  }

  private buildInspectorFallbackTasks(mission: string): Task[] {
    const trimmedMission = mission.trim()
    if (!trimmedMission) return []
    return [
      {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        type: 'other',
        status: 'pending',
        priority: 5,
        description: `执行主任务目标：${trimmedMission.slice(0, 120)}`,
        context:
          'Inspector 回退任务：模型未返回可解析的 tasks JSON。请先落地一个最小可交付结果，再拆分后续子任务。',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount: 0,
        maxAttempts: 3,
        reviewHistory: [],
      },
    ]
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private validateMissionWorktree(): string | null {
    const worktreePath = this.state.missionWorktree
    if (!worktreePath) return null
    if (existsSync(worktreePath)) return worktreePath

    this.logger.warn(`Mission worktree path no longer exists: ${worktreePath}`)
    this.state.missionWorktree = undefined
    this.state.missionBranch = undefined
    void saveManagerState(this.state)
    this.emitManagerState()
    return null
  }
}
