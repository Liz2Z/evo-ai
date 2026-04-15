import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { getControlFilePath, getHealthFilePath } from '../runtime/paths'
import { runInspector, runReviewer, runWorker } from '../slave/launcher'
import type { Config, MasterState, Question, ReviewResult, Task, TaskResult } from '../types'
import type {
  HeartbeatTickEvent,
  LogMessageEvent,
  MasterActivityEvent,
  MasterStateEvent,
  TaskStatusChangeEvent,
  WorktreeChangeEvent,
} from '../types/events'
import {
  commitAllChanges,
  deleteBranch,
  ensureMissionWorkspace,
  getUncommittedDiff,
  hasUncommittedChanges,
  listWorktrees,
  removeWorktree,
} from '../utils/git'
import { addToGlobalBuffer, appendTaskLog, Logger } from '../utils/logger'
import {
  addFailedTask,
  addHistoryEntry,
  addMissionHistoryEntry,
  addQuestion,
  addTask,
  loadFailedTasks,
  loadHistory,
  loadMasterState,
  loadMissionHistory,
  loadSlaves,
  loadTasks,
  type MissionHistoryEntry,
  saveMasterState,
  saveSlaves,
  updateMissionHistoryEntry,
  updateTask,
} from '../utils/storage'
import {
  type CommitTaskResult,
  createMasterRuntime,
  type MasterRuntime,
  type MasterRuntimeContext,
  type MasterTools,
  type MissionWorkspaceResult,
  type ReviewerAssignmentResult,
  type WorkerAssignmentResult,
} from './runtime'
import { sanitizeInspectorTasks } from './task-sanitizer'

interface MasterOptions {
  runtimeFactory?: (config: Config, state: MasterState) => MasterRuntime
}

function createInitialState(config: Config, mission: string): MasterState {
  return {
    mission,
    currentPhase: 'initializing',
    lastHeartbeat: '',
    lastInspection: '',
    activeSince: new Date().toISOString(),
    pendingQuestions: [],
    runtimeMode: config.master.runtimeMode,
    lastDecisionAt: '',
    turnStatus: 'idle',
    skippedWakeups: 0,
    currentStage: 'idle',
  }
}

export class Master extends EventEmitter {
  private readonly config: Config
  private readonly options?: MasterOptions
  private state: MasterState
  private activeSlaves = 0
  private isRunning = false
  private isPaused = false
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private currentTurnPromise: Promise<void> | null = null
  private readonly tools: MasterTools
  private runtime: MasterRuntime
  private readonly logger: Logger

  constructor(config: Config, mission: string, options?: MasterOptions) {
    super()
    this.config = { ...config, maxConcurrency: 1 }
    this.options = options
    this.state = createInitialState(this.config, mission)
    this.runtime = this.createRuntime(this.state)
    this.tools = this.createTools()
    this.logger = new Logger('Master')
  }

  async start(): Promise<void> {
    this.isRunning = true

    const savedState = await loadMasterState()
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
      runtimeMode: this.config.master.runtimeMode,
      turnStatus: savedState.turnStatus || 'idle',
      skippedWakeups: savedState.skippedWakeups || 0,
      currentStage: savedState.currentStage || 'idle',
    }
    this.isPaused = this.state.turnStatus === 'paused' || this.state.currentPhase === 'paused'
    this.runtime = this.createRuntime(this.state)

    await this.recoverStaleRuntimeState()
    await this.cleanupStaleWorktrees()
    await this.refreshActiveSlaves()
    await this.ensureMissionWorkspaceReady()

    this.clearControlFile()
    this.state.currentPhase = this.isPaused ? 'paused' : 'idle'
    this.state.turnStatus = this.isPaused ? 'paused' : 'idle'
    await saveMasterState(this.state)

    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'decision',
      summary: `Master started with mission: ${this.state.mission} (mode=${this.config.master.runtimeMode})`,
    })

    await this.runtime.init(await this.buildRuntimeContext('startup'), this.tools)
    this.emitMasterState()
    this.writeHealthFile()
    this.scheduleHeartbeat()
    void this.requestTurn('startup')
  }

  async stop(): Promise<void> {
    this.isRunning = false
    this.state.currentPhase = 'stopped'
    this.state.turnStatus = 'idle'

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    try {
      await this.runtime.dispose()
    } finally {
      await saveMasterState(this.state)
    }
  }

  pause(): void {
    this.isPaused = true
    this.state.currentPhase = 'paused'
    this.state.turnStatus = 'paused'
    this.writeHealthFile()
    void saveMasterState(this.state)
    this.emitMasterState()
  }

  resume(): void {
    this.isPaused = false
    this.state.currentPhase = 'idle'
    this.state.turnStatus = 'idle'
    this.writeHealthFile()
    void saveMasterState(this.state)
    this.emitMasterState()
    void this.requestTurn('resume')
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
    const task = await updateTask(taskId, { status: 'failed' })
    if (task && this.state.currentTaskId === taskId) {
      this.state.currentTaskId = undefined
      this.state.currentStage = 'idle'
      await saveMasterState(this.state)
      this.emitMasterState()
    }
    return task !== null
  }

  getState(): MasterState {
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
    this.state.mission = trimmed
    await saveMasterState(this.state)
    this.emitMasterState()

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
  }

  private async cleanupCurrentMission(): Promise<void> {
    const tasks = await loadTasks()

    this.logger.info('Cleaning up current mission before switch...')

    if (this.state.currentTaskId) {
      this.logger.info(`Abandoning current task: ${this.state.currentTaskId}`)
      await updateTask(this.state.currentTaskId, { status: 'failed' })
      this.state.currentTaskId = undefined
    }

    const worktreeToRemove = this.state.missionWorktree
    const branchToRemove = this.state.missionBranch

    if (worktreeToRemove && branchToRemove) {
      this.logger.info(`Removing mission worktree: ${worktreeToRemove}`)
      await removeWorktree(worktreeToRemove)
      await deleteBranch(branchToRemove)

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
        await updateTask(task.id, { status: 'failed' })
      }
    }

    this.state.currentStage = 'idle'
    this.state.turnStatus = 'idle'
    this.state.currentPhase = 'idle'

    await saveMasterState(this.state)

    this.logger.info('Mission cleanup completed')
  }

  async getMissionHistory(): Promise<MissionHistoryEntry[]> {
    return await loadMissionHistory()
  }

  private createRuntime(state: MasterState): MasterRuntime {
    if (this.options?.runtimeFactory) {
      return this.options.runtimeFactory(this.config, state)
    }
    return createMasterRuntime(this.config.master.runtimeMode, this.config, state)
  }

  private createTools(): MasterTools {
    return {
      get_master_snapshot: async () => {
        await this.refreshActiveSlaves()
        return {
          mission: this.state.mission,
          runtimeMode: this.state.runtimeMode,
          currentPhase: this.state.currentPhase,
          turnStatus: this.state.turnStatus,
          activeSlaves: this.activeSlaves,
          maxConcurrency: 1,
          pendingCount: (await loadTasks()).filter((task) => task.status === 'pending').length,
          pendingQuestions: this.state.pendingQuestions,
          lastHeartbeat: this.state.lastHeartbeat,
          lastDecisionAt: this.state.lastDecisionAt,
          skippedWakeups: this.state.skippedWakeups,
          lastSkippedTriggerReason: this.state.lastSkippedTriggerReason,
          runtimeSessionSummary: this.state.runtimeSessionSummary,
          missionBranch: this.state.missionBranch,
          missionWorktree: this.state.missionWorktree,
          currentTaskId: this.state.currentTaskId,
          currentStage: this.state.currentStage,
        }
      },
      list_tasks: async (input) => {
        const tasks = await loadTasks()
        if (!input?.status) return tasks
        const statuses = Array.isArray(input.status) ? input.status : [input.status]
        return tasks.filter((task) => statuses.includes(task.status))
      },
      list_slaves: async () => loadSlaves(),
      get_task: async ({ taskId }) => this.getTaskById(taskId),
      get_recent_history: async (input) => {
        const history = await loadHistory()
        return history.slice(-(input?.limit || 20))
      },
      get_current_task_diff: async () => {
        if (!this.state.missionWorktree) return ''
        return getUncommittedDiff(this.state.missionWorktree)
      },
      ensure_mission_workspace: async () => this.ensureMissionWorkspaceReady(),
      launch_inspector: async ({ reason }) => this.launchInspector(reason),
      assign_worker: async ({ taskId, additionalContext }) => {
        const task = await this.getTaskById(taskId)
        if (!task) {
          return {
            status: 'not_found',
            taskId,
            message: 'Task not found',
          } satisfies WorkerAssignmentResult
        }
        return this.assignWorker(task, additionalContext)
      },
      assign_reviewer: async ({ taskId }) => {
        const task = await this.getTaskById(taskId)
        if (!task) {
          return {
            status: 'not_found',
            taskId,
            message: 'Task not found',
          } satisfies ReviewerAssignmentResult
        }
        return this.assignReviewer(task)
      },
      create_task: async ({ description, type = 'other', priority = 3, context }) => {
        const task = await this.addTaskManually(description, type, priority)
        if (context) {
          const updated = await updateTask(task.id, { context })
          return updated || task
        }
        return task
      },
      update_task: async ({ taskId, patch }) => updateTask(taskId, patch),
      cancel_task: async ({ taskId }) => ({
        status: (await this.cancelTask(taskId)) ? 'cancelled' : 'noop',
        taskId,
      }),
      retry_task: async ({ taskId, additionalContext }) => {
        const task = await this.getTaskById(taskId)
        if (!task) return { status: 'not_found', taskId }
        if (task.status !== 'failed') return { status: 'noop', taskId }
        const context = additionalContext
          ? task.context
            ? `${task.context}\n\n${additionalContext}`
            : additionalContext
          : task.context
        await updateTask(task.id, { status: 'pending', context })
        return { status: 'retried', taskId }
      },
      commit_current_task: async () => this.commitCurrentTask(),
      ask_human: async ({ question, options }) => {
        const existing = this.state.pendingQuestions.find(
          (item) => !item.answered && item.question.trim() === question.trim(),
        )
        if (existing) return existing
        const created: Question = {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          question,
          options: options || [],
          createdAt: new Date().toISOString(),
          source: this.state.currentPhase,
        }
        await addQuestion(created)
        this.state.pendingQuestions = [...this.state.pendingQuestions, created]
        await saveMasterState(this.state)
        return created
      },
    }
  }

  private scheduleHeartbeat(): void {
    if (!this.isRunning) return
    this.heartbeatTimer = setTimeout(() => {
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

    if (this.currentTurnPromise) {
      this.state.skippedWakeups += 1
      this.state.lastSkippedTriggerReason = reason
      this.emitMasterActivity({
        timestamp: new Date().toISOString(),
        triggerReason: reason,
        summary: 'turn busy',
        toolCalls: [],
        kind: 'turn_skipped',
      })
      this.writeHealthFile()
      await saveMasterState(this.state)
      this.emitMasterState()
      return
    }

    this.currentTurnPromise = this.executeTurn(reason).finally(() => {
      this.currentTurnPromise = null
    })
    await this.currentTurnPromise
  }

  private async executeTurn(reason: string): Promise<void> {
    this.checkControlFile()
    if (!this.isRunning) return

    await this.syncPersistedStateFields()
    if (this.isPaused) {
      this.state.currentPhase = 'paused'
      this.state.turnStatus = 'paused'
      this.writeHealthFile()
      await saveMasterState(this.state)
      this.emitMasterState()
      return
    }

    await this.refreshActiveSlaves()

    this.state.lastHeartbeat = new Date().toISOString()
    this.state.currentPhase = 'running'
    this.state.turnStatus = 'running'
    this.emitMasterActivity({
      timestamp: this.state.lastHeartbeat,
      triggerReason: reason,
      summary: `trigger=${reason}`,
      toolCalls: [],
      kind: 'turn_started',
    })
    this.writeHealthFile()
    this.emitMasterState()

    const tasks = await loadTasks()
    this.emit('heartbeat', {
      timestamp: this.state.lastHeartbeat,
      phase: this.state.currentPhase,
      activeSlaves: this.activeSlaves,
      pendingCount: tasks.filter((task) => task.status === 'pending').length,
    } satisfies HeartbeatTickEvent)

    try {
      const context = await this.buildRuntimeContext(reason)
      const result = await this.runtime.runTurn(context, this.tools)
      this.emitMasterActivity({
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

      await this.handleFailedTasks()
      await addHistoryEntry({
        timestamp: this.state.lastDecisionAt,
        type: 'decision',
        summary: `Master turn completed (${this.state.runtimeMode}, trigger=${reason}) tools=[${result.toolCalls.join(', ') || 'none'}]`,
        details: {
          summary: result.summary,
          unauthorizedToolCalls: result.unauthorizedToolCalls,
        },
      })
    } catch (error) {
      this.emitMasterActivity({
        timestamp: new Date().toISOString(),
        triggerReason: reason,
        summary: error instanceof Error ? error.message : String(error),
        toolCalls: [],
        kind: 'turn_failed',
      })
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'error',
        summary: `Master turn failed: ${error}`,
      })
    } finally {
      await this.refreshActiveSlaves()
      this.state.currentPhase = 'idle'
      this.state.turnStatus = 'idle'
      this.writeHealthFile()
      await saveMasterState(this.state)
      this.emitMasterState()
    }
  }

  private async buildRuntimeContext(triggerReason: string): Promise<MasterRuntimeContext> {
    const [tasks, slaves, history] = await Promise.all([loadTasks(), loadSlaves(), loadHistory()])
    return {
      triggerReason,
      timestamp: new Date().toISOString(),
      mission: this.state.mission,
      config: this.config,
      masterState: this.getState(),
      tasks,
      slaves,
      recentHistory: history.slice(-20),
    }
  }

  private async refreshActiveSlaves(): Promise<void> {
    const slaves = await loadSlaves()
    this.activeSlaves = slaves.filter((slave) => slave.status === 'busy').length
  }

  private async syncPersistedStateFields(): Promise<void> {
    const persisted = await loadMasterState()
    if (persisted.mission) this.state.mission = persisted.mission
    this.state.pendingQuestions = persisted.pendingQuestions || []
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
    if (
      this.state.missionWorktree &&
      this.state.missionBranch &&
      existsSync(this.state.missionWorktree)
    ) {
      return {
        status: 'ready',
        path: this.state.missionWorktree,
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
    await saveMasterState(this.state)
    this.emit('worktree:change', {
      mission: this.state.mission,
      action: 'created',
      path: workspace.path,
      branch: workspace.branch,
    } satisfies WorktreeChangeEvent)
    this.emitMasterState()

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
    await this.refreshActiveSlaves()
    const tasks = await loadTasks()
    const hasActiveQueue = tasks.some((task) =>
      ['pending', 'running', 'reviewing'].includes(task.status),
    )
    if (this.activeSlaves > 0 || this.state.currentTaskId || hasActiveQueue) {
      return { status: 'noop', createdTaskIds: [], message: 'Mission queue is not idle' }
    }

    this.state.currentStage = 'inspecting'
    await saveMasterState(this.state)
    this.emitMasterState()
    this.activeSlaves++

    const recentDecisions = await this.getRecentDecisions()
    void runInspector(this.state.mission, recentDecisions)
      .then(async (newTasks) => {
        const existingTasks = await loadTasks()
        const { accepted, dropped } = sanitizeInspectorTasks(newTasks, existingTasks)
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
        this.activeSlaves = Math.max(0, this.activeSlaves - 1)
        await saveMasterState(this.state)
        this.emitMasterState()
        await this.requestTurn(`inspector_completed:${reason}`)
      })
      .catch(async (error) => {
        this.activeSlaves = Math.max(0, this.activeSlaves - 1)
        this.state.currentStage = 'idle'
        await addHistoryEntry({
          timestamp: new Date().toISOString(),
          type: 'error',
          summary: `Inspector failed: ${error}`,
        })
        await saveMasterState(this.state)
        this.emitMasterState()
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
    if (this.activeSlaves > 0) {
      return { status: 'noop', taskId: task.id, message: 'Another slave is already active' }
    }

    const workspace = await this.ensureMissionWorkspaceReady()
    if (workspace.status === 'failed' || !workspace.path) {
      return { status: 'noop', taskId: task.id, message: workspace.message }
    }

    const beforeStatus = freshTask.status
    await updateTask(freshTask.id, { status: 'running' })
    this.state.currentTaskId = freshTask.id
    this.state.currentStage = 'working'
    await saveMasterState(this.state)
    this.emitTaskStatusChange(freshTask.id, beforeStatus, 'running', {
      ...freshTask,
      status: 'running',
    })
    this.emitMasterState()

    this.activeSlaves++
    const recentDecisions = await this.getRecentDecisions()
    const onLog = (event: LogMessageEvent) => this.handleLogEvent(event)

    void runWorker(
      { ...freshTask, status: 'running' },
      this.state.mission,
      recentDecisions,
      additionalContext,
      workspace.path,
      onLog,
    )
      .then(async (result) => {
        if (result) {
          await this.handleWorkerResult(freshTask.id, result)
        } else {
          await this.failTask(freshTask.id, 'Worker returned no result')
        }
        this.activeSlaves = Math.max(0, this.activeSlaves - 1)
        await this.requestTurn(`worker_completed:${freshTask.id}`)
      })
      .catch(async (error) => {
        await this.failTask(freshTask.id, error instanceof Error ? error.message : String(error))
        this.activeSlaves = Math.max(0, this.activeSlaves - 1)
        await this.requestTurn(`worker_failed:${freshTask.id}`)
      })

    return { status: 'started', taskId: freshTask.id, message: 'Worker assigned' }
  }

  private async handleWorkerResult(taskId: string, result: TaskResult): Promise<void> {
    const latestTask = await this.getTaskById(taskId)
    if (!latestTask) return

    if (result.status === 'completed') {
      await updateTask(taskId, { status: 'reviewing' })
      this.state.currentTaskId = taskId
      this.state.currentStage = 'reviewing'
      await saveMasterState(this.state)
      this.emitTaskStatusChange(taskId, latestTask.status, 'reviewing', {
        ...latestTask,
        status: 'reviewing',
      })
      this.emitMasterState()
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
    if (!this.state.missionWorktree) {
      return { status: 'noop', taskId: task.id, message: 'Mission workspace is missing' }
    }
    if (this.activeSlaves > 0) {
      return { status: 'noop', taskId: task.id, message: 'Another slave is already active' }
    }

    const diff = await getUncommittedDiff(this.state.missionWorktree)
    if (!diff.trim()) {
      await this.failTask(task.id, 'No diff to review in mission workspace')
      return { status: 'noop', taskId: task.id, message: 'No diff to review' }
    }

    this.state.currentTaskId = task.id
    this.state.currentStage = 'reviewing'
    await saveMasterState(this.state)
    this.emitMasterState()

    this.activeSlaves++
    const recentDecisions = await this.getRecentDecisions()
    const onLog = (event: LogMessageEvent) => this.handleLogEvent(event)

    void runReviewer(
      task,
      this.state.mission,
      recentDecisions,
      diff,
      this.state.missionWorktree,
      onLog,
    )
      .then(async (result) => {
        if (result) {
          await this.handleReviewResult(task.id, result)
        } else {
          await this.failTask(task.id, 'Reviewer returned no result')
        }
        this.activeSlaves = Math.max(0, this.activeSlaves - 1)
        await this.requestTurn(`review_completed:${task.id}`)
      })
      .catch(async (error) => {
        await this.failTask(task.id, error instanceof Error ? error.message : String(error))
        this.activeSlaves = Math.max(0, this.activeSlaves - 1)
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
      slaveId: 'reviewer',
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
      await updateTask(taskId, {
        status: 'reviewing',
        attemptCount: nextAttempt,
        reviewHistory,
      })
      this.state.currentTaskId = taskId
      this.state.currentStage = 'committing'
      await saveMasterState(this.state)
      this.emitMasterState()
      return
    }

    if (result.verdict === 'reject' || nextAttempt >= latestTask.maxAttempts) {
      await updateTask(taskId, {
        status: 'failed',
        attemptCount: nextAttempt,
        reviewHistory,
      })
      this.state.currentTaskId = undefined
      this.state.currentStage = 'idle'
      await saveMasterState(this.state)
      this.emitTaskStatusChange(taskId, latestTask.status, 'failed', {
        ...latestTask,
        status: 'failed',
        attemptCount: nextAttempt,
        reviewHistory,
      })
      this.emitMasterState()
      return
    }

    const additionalContext = this.buildRetryContext(result)
    await updateTask(taskId, {
      status: 'running',
      attemptCount: nextAttempt,
      context: latestTask.context
        ? `${latestTask.context}\n\n${additionalContext}`
        : additionalContext,
      reviewHistory,
    })
    this.state.currentTaskId = taskId
    this.state.currentStage = 'working'
    await saveMasterState(this.state)
    this.emitTaskStatusChange(taskId, latestTask.status, 'running', {
      ...latestTask,
      status: 'running',
      attemptCount: nextAttempt,
      context: latestTask.context
        ? `${latestTask.context}\n\n${additionalContext}`
        : additionalContext,
      reviewHistory,
    })
    this.emitMasterState()
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
    if (!this.state.missionWorktree) {
      return { status: 'failed', taskId, message: 'Mission workspace is missing' }
    }

    const task = await this.getTaskById(taskId)
    if (!task) {
      return { status: 'not_found', taskId, message: 'Task not found' }
    }

    const hasChanges = await hasUncommittedChanges(this.state.missionWorktree)
    if (!hasChanges) {
      await this.failTask(taskId, 'No changes to commit for current task')
      return { status: 'failed', taskId, message: 'No changes to commit' }
    }

    this.state.currentStage = 'committing'
    await saveMasterState(this.state)
    this.emitMasterState()

    const result = await commitAllChanges(this.buildCommitMessage(task), this.state.missionWorktree)
    if (!result.success) {
      await this.failTask(taskId, result.message)
      return { status: 'failed', taskId, message: result.message }
    }

    await updateTask(taskId, { status: 'completed' })
    this.state.currentTaskId = undefined
    this.state.currentStage = 'idle'
    await saveMasterState(this.state)
    this.emitTaskStatusChange(taskId, task.status, 'completed', { ...task, status: 'completed' })
    this.emitMasterState()
    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'task_completed',
      taskId,
      summary: `Task committed: ${this.buildCommitMessage(task)}`,
    })

    return { status: 'committed', taskId, message: result.message }
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

    await updateTask(taskId, {
      status: 'failed',
      context: latestTask.context
        ? `${latestTask.context}\n\nFailure: ${reason}`
        : `Failure: ${reason}`,
    })
    this.state.currentTaskId = undefined
    this.state.currentStage = 'idle'
    await saveMasterState(this.state)
    this.emitTaskStatusChange(taskId, latestTask.status, 'failed', {
      ...latestTask,
      status: 'failed',
      context: latestTask.context
        ? `${latestTask.context}\n\nFailure: ${reason}`
        : `Failure: ${reason}`,
    })
    this.emitMasterState()
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
      slaveId: event.slaveId,
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

  private emitMasterState(): void {
    this.emit('master:state', {
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
    } satisfies MasterStateEvent)
  }

  private emitMasterActivity(event: MasterActivityEvent): void {
    this.emit('master:activity', event)
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
          activeSlaves: this.activeSlaves,
          lastHeartbeat: this.state.lastHeartbeat,
          lastDecisionAt: this.state.lastDecisionAt,
          skippedWakeups: this.state.skippedWakeups,
          lastSkippedTriggerReason: this.state.lastSkippedTriggerReason,
          heartbeatInterval: this.config.heartbeatInterval,
          currentStage: this.state.currentStage,
          currentTaskId: this.state.currentTaskId,
          missionWorktree: this.state.missionWorktree,
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
      await removeWorktree(worktree)
    }
  }

  private async recoverStaleRuntimeState(): Promise<void> {
    const slaves = await loadSlaves()
    const recoveredSlaves = slaves.map((slave) =>
      slave.status === 'busy'
        ? { ...slave, status: 'idle' as const, currentTask: undefined }
        : slave,
    )
    if (recoveredSlaves.some((slave, index) => slave !== slaves[index])) {
      await saveSlaves(recoveredSlaves)
    }

    const tasks = await loadTasks()
    let changed = false
    for (const task of tasks) {
      if (task.status !== 'running' && task.status !== 'reviewing') continue
      changed = true
      const recoveredStatus = this.state.currentTaskId === task.id ? task.status : 'pending'
      await updateTask(task.id, { status: recoveredStatus })
    }

    if (changed) {
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'decision',
        summary: 'Recovered stale runtime state: reset busy slaves and resumed mission pipeline',
      })
    }

    if (this.state.currentStage === 'committing' && this.state.currentTaskId) {
      this.state.currentStage = 'reviewing'
    }
  }
}
