// Auto-generated
import { EventEmitter } from "events";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { getControlFilePath, getHealthFilePath } from "../runtime/paths";
import { Logger } from "../utils/logger";
import { runInspector, runReviewer, runWorker } from "../slave/launcher";
import type { Config, MasterState, Question, ReviewResult, Task, TaskResult } from "../types";
import type { HeartbeatTickEvent, MasterStateEvent, TaskStatusChangeEvent } from "../types/events";
import { deleteBranch, getDiff, listWorktrees, mergeBranch, removeWorktree } from "../utils/git";
import {
  addFailedTask,
  addHistoryEntry,
  addQuestion,
  addTask,
  loadFailedTasks,
  loadHistory,
  loadMasterState,
  loadSlaves,
  loadTasks,
  saveMasterState,
  saveSlaves,
  saveTasks,
  updateTask,
} from "../utils/storage";
import {
  type CleanupArtifactsResult,
  createMasterRuntime,
  type MasterRuntime,
  type MasterRuntimeContext,
  type MasterTools,
  type MergeTaskResult,
  type ReviewerAssignmentResult,
  type WorkerAssignmentResult,
} from "./runtime";

interface MasterOptions {
  runtimeFactory?: (config: Config, state: MasterState) => MasterRuntime;
}

export class Master extends EventEmitter {
  private readonly config: Config;
  private readonly options?: MasterOptions;
  private state: MasterState;
  private activeSlaves = 0;
  private isRunning = false;
  private isPaused = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private currentTurnPromise: Promise<void> | null = null;
  private readonly tools: MasterTools;
  private runtime: MasterRuntime;
  private readonly logger: Logger;

  constructor(config: Config, mission: string, options?: MasterOptions) {
    super();
    this.config = config;
    this.options = options;
    this.state = {
      mission,
      currentPhase: "initializing",
      lastHeartbeat: "",
      lastInspection: "",
      activeSince: new Date().toISOString(),
      pendingQuestions: [],
      runtimeMode: config.master.runtimeMode,
      lastDecisionAt: "",
      turnStatus: "idle",
      skippedWakeups: 0,
    };
    this.runtime = this.createRuntime(this.state);
    this.tools = this.createTools();
    this.logger = new Logger("Master");
  }

  async start(): Promise<void> {
    this.isRunning = true;

    const savedState = await loadMasterState();
    this.state = {
      ...this.state,
      ...savedState,
      mission: this.state.mission || savedState.mission,
      runtimeMode: this.config.master.runtimeMode,
      turnStatus: savedState.turnStatus || "idle",
      skippedWakeups: savedState.skippedWakeups || 0,
    };
    this.isPaused = this.state.turnStatus === "paused" || this.state.currentPhase === "paused";

    this.runtime = this.createRuntime(this.state);

    this.logger.info(`Master starting with mission: ${this.state.mission}`);
    this.logger.info(`Heartbeat interval: ${this.config.heartbeatInterval}ms`);
    this.logger.info(`Max concurrency: ${this.config.maxConcurrency}`);
    this.logger.info(`Master runtime mode: ${this.config.master.runtimeMode}`);

    await this.recoverStaleRuntimeState();
    await this.cleanupStaleWorktrees();
    await this.refreshActiveSlaves();

    this.clearControlFile();
    this.state.currentPhase = this.isPaused ? "paused" : "idle";
    this.state.turnStatus = this.isPaused ? "paused" : "idle";
    await saveMasterState(this.state);

    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: "decision",
      summary: `Master started with mission: ${this.state.mission} (mode=${this.config.master.runtimeMode})`,
    });

    await this.runtime.init(await this.buildRuntimeContext("startup"), this.tools);
    this.emitMasterState();
    this.writeHealthFile();
    this.scheduleHeartbeat();
    void this.requestTurn("startup");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.state.currentPhase = "stopped";
    this.state.turnStatus = "idle";

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    try {
      await this.runtime.dispose();
    } finally {
      await saveMasterState(this.state);
    }

    this.logger.info("Master stopped");
  }

  pause(): void {
    this.isPaused = true;
    this.state.currentPhase = "paused";
    this.state.turnStatus = "paused";
    this.writeHealthFile();
    void saveMasterState(this.state);
    this.emitMasterState();
    this.logger.info("Master paused");
  }

  resume(): void {
    this.isPaused = false;
    this.state.currentPhase = "idle";
    this.state.turnStatus = "idle";
    this.writeHealthFile();
    void saveMasterState(this.state);
    this.emitMasterState();
    this.logger.info("Master resumed");
    void this.requestTurn("resume");
  }

  async addTaskManually(
    description: string,
    type: Task["type"] = "other",
    priority = 3,
  ): Promise<Task> {
    const task: Task = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      type,
      status: "pending",
      priority,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 0,
      maxAttempts: this.config.maxRetryAttempts,
      reviewHistory: [],
    };

    await addTask(task);
    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: "task_created",
      taskId: task.id,
      summary: `Task created manually: ${description.slice(0, 100)}`,
    });
    return task;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = await updateTask(taskId, { status: "failed" });
    return task !== null;
  }

  getState(): MasterState {
    return { ...this.state };
  }

  async setMission(mission: string): Promise<void> {
    this.state.mission = mission;
    await saveMasterState(this.state);
    this.emitMasterState();
    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: "decision",
      summary: `Mission updated: ${mission}`,
    });
  }

  private createRuntime(state: MasterState): MasterRuntime {
    if (this.options?.runtimeFactory) {
      return this.options.runtimeFactory(this.config, state);
    }
    return createMasterRuntime(this.config.master.runtimeMode, this.config, state);
  }

  private createTools(): MasterTools {
    return {
      get_master_snapshot: async () => {
        await this.refreshActiveSlaves();
        return {
          mission: this.state.mission,
          runtimeMode: this.state.runtimeMode,
          currentPhase: this.state.currentPhase,
          turnStatus: this.state.turnStatus,
          activeSlaves: this.activeSlaves,
          maxConcurrency: this.config.maxConcurrency,
          pendingCount: (await loadTasks()).filter((task) => task.status === "pending").length,
          pendingQuestions: this.state.pendingQuestions,
          lastHeartbeat: this.state.lastHeartbeat,
          lastDecisionAt: this.state.lastDecisionAt,
          skippedWakeups: this.state.skippedWakeups,
          lastSkippedTriggerReason: this.state.lastSkippedTriggerReason,
          runtimeSessionSummary: this.state.runtimeSessionSummary,
        };
      },
      list_tasks: async (input) => {
        const tasks = await loadTasks();
        if (!input?.status) return tasks;
        const statuses = Array.isArray(input.status) ? input.status : [input.status];
        return tasks.filter((task) => statuses.includes(task.status));
      },
      list_slaves: async () => loadSlaves(),
      get_task: async ({ taskId }) => {
        const tasks = await loadTasks();
        return tasks.find((task) => task.id === taskId) || null;
      },
      get_recent_history: async (input) => {
        const history = await loadHistory();
        const limit = input?.limit || 20;
        return history.slice(-limit);
      },
      get_task_diff: async ({ taskId, branch }) => {
        let resolvedBranch = branch;
        let cwd: string | undefined;
        if (taskId) {
          const tasks = await loadTasks();
          const task = tasks.find((item) => item.id === taskId);
          if (!task?.branch) return "";
          resolvedBranch = task.branch;
          cwd = task.worktree;
        }
        if (!resolvedBranch) return "";
        return getDiff(resolvedBranch, this.config.developBranch, cwd);
      },
      launch_inspector: async ({ reason }) => this.launchInspector(reason),
      assign_worker: async ({ taskId, additionalContext }) => {
        const task = await this.getTaskById(taskId);
        if (!task) {
          return {
            status: "not_found",
            taskId,
            message: "Task not found",
          } satisfies WorkerAssignmentResult;
        }
        return this.assignWorker(task, additionalContext);
      },
      assign_reviewer: async ({ taskId }) => {
        const task = await this.getTaskById(taskId);
        if (!task) {
          return {
            status: "not_found",
            taskId,
            message: "Task not found",
          } satisfies ReviewerAssignmentResult;
        }
        return this.assignReviewer(task);
      },
      create_task: async ({ description, type = "other", priority = 3, context }) => {
        const task = await this.addTaskManually(description, type, priority);
        if (context) {
          const updated = await updateTask(task.id, { context });
          return updated || task;
        }
        return task;
      },
      update_task: async ({ taskId, patch }) => updateTask(taskId, patch),
      cancel_task: async ({ taskId }) => {
        const cancelled = await this.cancelTask(taskId);
        return { status: cancelled ? "cancelled" : "noop", taskId };
      },
      retry_task: async ({ taskId, additionalContext }) => {
        const task = await this.getTaskById(taskId);
        if (!task) {
          return { status: "not_found", taskId };
        }
        if (
          !["failed", "rejected"].includes(task.status) ||
          task.attemptCount >= task.maxAttempts
        ) {
          return { status: "noop", taskId };
        }
        const context = additionalContext
          ? task.context
            ? `${task.context}\n\n${additionalContext}`
            : additionalContext
          : task.context;
        await updateTask(task.id, { status: "pending", context });
        return { status: "retried", taskId };
      },
      merge_task: async ({ taskId }) => {
        const task = await this.getTaskById(taskId);
        if (!task) {
          return {
            status: "not_found",
            taskId,
            message: "Task not found",
          } satisfies MergeTaskResult;
        }
        return this.mergeTask(task);
      },
      cleanup_task_artifacts: async ({ taskId }) => {
        const task = await this.getTaskById(taskId);
        if (!task) {
          return {
            taskId,
            removedBranch: false,
            removedWorktree: false,
          } satisfies CleanupArtifactsResult;
        }
        return this.cleanupTaskArtifacts(task);
      },
      ask_human: async ({ question, options }) => {
        const existing = this.state.pendingQuestions.find(
          (item) => !item.answered && item.question.trim() === question.trim(),
        );
        if (existing) {
          return existing;
        }
        const created: Question = {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          question,
          options: options || [],
          createdAt: new Date().toISOString(),
          source: this.state.currentPhase,
        };
        await addQuestion(created);
        this.state.pendingQuestions = [...this.state.pendingQuestions, created];
        await saveMasterState(this.state);
        return created;
      },
    };
  }

  private scheduleHeartbeat(): void {
    if (!this.isRunning) return;
    this.heartbeatTimer = setTimeout(() => {
      void this.requestTurn("heartbeat");
      this.scheduleHeartbeat();
    }, this.config.heartbeatInterval);
  }

  private async requestTurn(reason: string): Promise<void> {
    if (!this.isRunning) return;

    if (this.runtime.onExternalEvent) {
      await this.runtime.onExternalEvent({ reason, timestamp: new Date().toISOString() });
    }

    if (this.currentTurnPromise) {
      this.state.skippedWakeups += 1;
      this.state.lastSkippedTriggerReason = reason;
      this.logger.debug(`Turn skipped (busy), reason=${reason} skippedWakeups=${this.state.skippedWakeups}`);
      this.writeHealthFile();
      await saveMasterState(this.state);
      this.emitMasterState();
      return;
    }

    this.logger.info(`Turn requested: reason=${reason}`);

    this.currentTurnPromise = this.executeTurn(reason).finally(() => {
      this.currentTurnPromise = null;
    });
    await this.currentTurnPromise;
  }

  private async executeTurn(reason: string): Promise<void> {
    this.checkControlFile();

    if (!this.isRunning) return;

    await this.syncPersistedStateFields();

    if (this.isPaused) {
      this.state.currentPhase = "paused";
      this.state.turnStatus = "paused";
      this.writeHealthFile();
      await saveMasterState(this.state);
      this.emitMasterState();
      return;
    }

    await this.refreshActiveSlaves();

    this.state.lastHeartbeat = new Date().toISOString();
    this.state.currentPhase = "running";
    this.state.turnStatus = "running";
    this.writeHealthFile();
    this.emitMasterState();

    const tasks = await loadTasks();
    const pendingCount = tasks.filter((task) => task.status === "pending").length;
    this.emit("heartbeat", {
      timestamp: this.state.lastHeartbeat,
      phase: this.state.currentPhase,
      activeSlaves: this.activeSlaves,
      pendingCount,
    } satisfies HeartbeatTickEvent);

    try {
      const context = await this.buildRuntimeContext(reason);
      this.logger.info(`Running turn: activeSlaves=${this.activeSlaves} pending=${context.tasks.filter(t => t.status === 'pending').length} reviewing=${context.tasks.filter(t => t.status === 'reviewing').length} approved=${context.tasks.filter(t => t.status === 'approved').length}`);
      const result = await this.runtime.runTurn(context, this.tools);

      this.state.lastDecisionAt = new Date().toISOString();
      if (result.sessionSummary !== undefined) {
        this.state.runtimeSessionSummary = result.sessionSummary;
      }

      this.logger.info(`Turn completed: tools=[${result.toolCalls.join(', ') || 'none'}] summary=${result.summary.slice(0, 200)}`);

      await this.handleFailedTasks();

      await addHistoryEntry({
        timestamp: this.state.lastDecisionAt,
        type: "decision",
        summary: `Master turn completed (${this.state.runtimeMode}, trigger=${reason}) tools=[${result.toolCalls.join(", ") || "none"}]`,
        details: {
          summary: result.summary,
          unauthorizedToolCalls: result.unauthorizedToolCalls,
        },
      });

      if (result.unauthorizedToolCalls.length > 0) {
        await addHistoryEntry({
          timestamp: new Date().toISOString(),
          type: "error",
          summary: `Master attempted unauthorized tools: ${result.unauthorizedToolCalls.join(", ")}`,
        });
      }
    } catch (error) {
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: "error",
        summary: `Master turn failed: ${error}`,
      });
    } finally {
      await this.refreshActiveSlaves();
      this.state.currentPhase = "idle";
      this.state.turnStatus = "idle";
      this.writeHealthFile();
      await saveMasterState(this.state);
      this.emitMasterState();
    }
  }

  private async buildRuntimeContext(triggerReason: string): Promise<MasterRuntimeContext> {
    const [tasks, slaves, history] = await Promise.all([loadTasks(), loadSlaves(), loadHistory()]);

    return {
      triggerReason,
      timestamp: new Date().toISOString(),
      mission: this.state.mission,
      config: this.config,
      masterState: this.getState(),
      tasks,
      slaves,
      recentHistory: history.slice(-20),
    };
  }

  private async refreshActiveSlaves(): Promise<void> {
    const slaves = await loadSlaves();
    this.activeSlaves = slaves.filter((slave) => slave.status === "busy").length;
  }

  private async syncPersistedStateFields(): Promise<void> {
    const persisted = await loadMasterState();
    if (persisted.mission) {
      this.state.mission = persisted.mission;
    }
    this.state.pendingQuestions = persisted.pendingQuestions || [];
  }

  private async getTaskById(taskId: string): Promise<Task | null> {
    const tasks = await loadTasks();
    return tasks.find((task) => task.id === taskId) || null;
  }

  private async launchInspector(
    reason: string,
  ): Promise<{ status: "started" | "noop"; createdTaskIds: string[]; message: string }> {
    await this.refreshActiveSlaves();
    if (this.activeSlaves >= this.config.maxConcurrency) {
      return {
        status: "noop",
        createdTaskIds: [],
        message: "No concurrency slot available for inspector",
      };
    }

    const slaves = await loadSlaves();
    if (slaves.some((slave) => slave.type === "inspector" && slave.status === "busy")) {
      return { status: "noop", createdTaskIds: [], message: "Inspector already running" };
    }

    const recentDecisions = await this.getRecentDecisions();
    this.activeSlaves++;

    void runInspector(this.state.mission, recentDecisions)
      .then(async (newTasks) => {
        const createdTaskIds: string[] = [];
        for (const task of newTasks) {
          await addTask(task);
          createdTaskIds.push(task.id);
          await addHistoryEntry({
            timestamp: new Date().toISOString(),
            type: "task_created",
            taskId: task.id,
            summary: `Inspector created task: ${task.description.slice(0, 100)}`,
          });
        }
        this.logger.info(`Inspector finished: found ${newTasks.length} task(s)${newTasks.length > 0 ? ` [${newTasks.map(t => t.description.slice(0, 50)).join(' | ')}]` : ''}`);
        this.state.lastInspection = new Date().toISOString();
        this.activeSlaves = Math.max(0, this.activeSlaves - 1);
        await saveMasterState(this.state);
        await this.requestTurn(`inspector_completed:${reason}`);
      })
      .catch(async (error) => {
        this.logger.error(`Inspector failed: ${error}`);
        this.activeSlaves = Math.max(0, this.activeSlaves - 1);
        await addHistoryEntry({
          timestamp: new Date().toISOString(),
          type: "error",
          summary: `Inspector failed: ${error}`,
        });
        await this.requestTurn("inspector_failed");
      });

    return { status: "started", createdTaskIds: [], message: `Inspector launched (${reason})` };
  }

  private async assignWorker(task: Task, additionalContext = ""): Promise<WorkerAssignmentResult> {
    const freshTask = await this.getTaskById(task.id);
    if (!freshTask) {
      return { status: "not_found", taskId: task.id, message: "Task not found" };
    }
    if (freshTask.status !== "pending") {
      return { status: "noop", taskId: task.id, message: `Task is ${freshTask.status}` };
    }

    await this.refreshActiveSlaves();
    if (this.activeSlaves >= this.config.maxConcurrency) {
      return { status: "noop", taskId: task.id, message: "No concurrency slot available" };
    }

    await updateTask(freshTask.id, { status: "assigned" });
    this.emit("task:status_change", {
      taskId: freshTask.id,
      fromStatus: freshTask.status,
      toStatus: "assigned",
      task: { ...freshTask, status: "assigned" },
    } satisfies TaskStatusChangeEvent);

    this.activeSlaves++;
    const recentDecisions = await this.getRecentDecisions();
    const baseBranch = this.config.developBranch;

    void runWorker(freshTask, this.state.mission, recentDecisions, additionalContext, baseBranch)
      .then(async (result) => {
        if (result) {
          await this.handleWorkerResult(freshTask, result);
        } else {
          await this.markWorkerFailure(freshTask.id, "Worker returned no result");
        }
        this.activeSlaves = Math.max(0, this.activeSlaves - 1);
        await this.requestTurn(`worker_completed:${freshTask.id}`);
      })
      .catch(async (error) => {
        this.logger.error(`Worker failed for task ${freshTask.id}: ${error}`);
        await this.markWorkerFailure(
          freshTask.id,
          error instanceof Error ? error.message : String(error),
        );
        this.activeSlaves = Math.max(0, this.activeSlaves - 1);
        await this.requestTurn(`worker_failed:${freshTask.id}`);
      });

    return { status: "started", taskId: freshTask.id, message: "Worker assigned" };
  }

  private async handleWorkerResult(task: Task, result: TaskResult): Promise<void> {
    if (result.status === "completed") {
      const newStatus = "reviewing" as const;
      await updateTask(task.id, {
        status: newStatus,
        worktree: result.worktree,
        branch: result.branch,
      });
      this.emit("task:status_change", {
        taskId: task.id,
        fromStatus: "assigned",
        toStatus: newStatus,
        task: { ...task, status: newStatus, worktree: result.worktree, branch: result.branch },
      } satisfies TaskStatusChangeEvent);

      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: "task_completed",
        taskId: task.id,
        summary: `Task completed, pending review. ${result.summary.slice(0, 100)}`,
        details: { filesChanged: result.filesChanged },
      });
      return;
    }

    await this.markWorkerFailure(task.id, result.error || result.summary);
  }

  private async markWorkerFailure(taskId: string, reason: string): Promise<void> {
    const latestTask = await this.getTaskById(taskId);
    if (!latestTask) return;

    const nextAttemptCount = latestTask.attemptCount + 1;
    const retryable = nextAttemptCount < latestTask.maxAttempts;
    const failureContext = `Worker failure (attempt ${nextAttemptCount}/${latestTask.maxAttempts}): ${reason}`;
    const mergedContext = latestTask.context
      ? `${latestTask.context}\n\n${failureContext}`
      : failureContext;
    const nextStatus: Task["status"] = retryable ? "pending" : "failed";

    await updateTask(taskId, {
      status: nextStatus,
      attemptCount: nextAttemptCount,
      context: mergedContext,
    });

    this.emit("task:status_change", {
      taskId,
      fromStatus: latestTask.status,
      toStatus: nextStatus,
      task: {
        ...latestTask,
        status: nextStatus,
        attemptCount: nextAttemptCount,
        context: mergedContext,
      },
    } satisfies TaskStatusChangeEvent);
  }

  private async assignReviewer(task: Task): Promise<ReviewerAssignmentResult> {
    const freshTask = await this.getTaskById(task.id);
    if (!freshTask) {
      return { status: "not_found", taskId: task.id, message: "Task not found" };
    }
    if (freshTask.status !== "reviewing") {
      return { status: "noop", taskId: task.id, message: `Task is ${freshTask.status}` };
    }

    if (!freshTask.worktree || !freshTask.branch) {
      await updateTask(freshTask.id, { status: "approved" });
      return {
        status: "approved",
        taskId: freshTask.id,
        message: "Task auto-approved without worktree",
      };
    }

    await this.refreshActiveSlaves();
    if (this.activeSlaves >= this.config.maxConcurrency) {
      return { status: "noop", taskId: freshTask.id, message: "No concurrency slot available" };
    }

    const diff = await getDiff(freshTask.branch, this.config.developBranch, freshTask.worktree);
    if (!diff) {
      await this.finalizeTaskWorktree(freshTask, "approved");
      return {
        status: "approved",
        taskId: freshTask.id,
        message: "Task auto-approved due to empty diff",
      };
    }

    this.activeSlaves++;
    const recentDecisions = await this.getRecentDecisions();

    void runReviewer(freshTask, this.state.mission, recentDecisions, diff)
      .then(async (result) => {
        if (result) {
          await this.handleReviewResult(freshTask, result);
        }
        this.activeSlaves = Math.max(0, this.activeSlaves - 1);
        await this.requestTurn(`review_completed:${freshTask.id}`);
      })
      .catch(async (error) => {
        this.logger.error(`Review failed for task ${freshTask.id}: ${error}`);
        this.activeSlaves = Math.max(0, this.activeSlaves - 1);
        await this.requestTurn(`review_failed:${freshTask.id}`);
      });

    return { status: "started", taskId: freshTask.id, message: "Reviewer assigned" };
  }

  private async handleReviewResult(task: Task, result: ReviewResult): Promise<void> {
    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: "review",
      taskId: task.id,
      summary: `Review: ${result.verdict} (${result.confidence}) - ${result.summary}`,
      details: { issues: result.issues, suggestions: result.suggestions },
    });

    const latestTask = await this.getTaskById(task.id);
    const currentTask = latestTask || task;
    const reviewEntry = {
      attempt: currentTask.attemptCount + 1,
      slaveId: "reviewer",
      review: result,
      timestamp: new Date().toISOString(),
    };

    if (result.verdict === "approve") {
      const newStatus = "approved" as const;
      await updateTask(currentTask.id, {
        status: newStatus,
        attemptCount: currentTask.attemptCount + 1,
        reviewHistory: [...currentTask.reviewHistory, reviewEntry],
      });
      await this.finalizeTaskWorktree(currentTask, newStatus);
      return;
    }

    if (result.verdict === "reject" || currentTask.attemptCount + 1 >= currentTask.maxAttempts) {
      const newStatus = "rejected" as const;
      await updateTask(currentTask.id, {
        status: newStatus,
        attemptCount: currentTask.attemptCount + 1,
        reviewHistory: [...currentTask.reviewHistory, reviewEntry],
      });
      await this.finalizeTaskWorktree(currentTask, newStatus);
      return;
    }

    const additionalContext = this.buildRetryContext(result);
    await updateTask(currentTask.id, {
      status: "pending",
      attemptCount: currentTask.attemptCount + 1,
      context: currentTask.context
        ? `${currentTask.context}\n\n${additionalContext}`
        : additionalContext,
      reviewHistory: [...currentTask.reviewHistory, reviewEntry],
    });
  }

  private buildRetryContext(result: ReviewResult): string {
    let context = "## Previous Review Feedback\n\n";

    if (result.issues.length > 0) {
      context +=
        "**Issues to fix:**\n" + result.issues.map((issue) => `- ${issue}`).join("\n") + "\n\n";
    }

    if (result.suggestions.length > 0) {
      context +=
        "**Suggestions:**\n" +
        result.suggestions.map((suggestion) => `- ${suggestion}`).join("\n") +
        "\n\n";
    }

    context += `**Summary:** ${result.summary}\n`;
    return context;
  }

  private async mergeTask(task: Task): Promise<MergeTaskResult> {
    const freshTask = await this.getTaskById(task.id);
    if (!freshTask) {
      return { status: "not_found", taskId: task.id, message: "Task not found" };
    }
    if (freshTask.status === "completed") {
      return { status: "noop", taskId: task.id, message: "Task already completed" };
    }
    if (freshTask.status !== "approved") {
      return { status: "noop", taskId: task.id, message: `Task is ${freshTask.status}` };
    }
    if (!freshTask.branch) {
      return { status: "failed", taskId: task.id, message: "Approved task is missing branch" };
    }

    const lastReview = freshTask.reviewHistory[freshTask.reviewHistory.length - 1];
    if (lastReview && lastReview.review.verdict !== "approve") {
      return { status: "failed", taskId: task.id, message: "Last review verdict is not approve" };
    }

    const result = await mergeBranch(freshTask.branch, this.config.developBranch);
    if (!result.success) {
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: "error",
        taskId: freshTask.id,
        summary: `Merge failed: ${result.message}`,
      });
      await updateTask(freshTask.id, { status: "failed" });
      return { status: "failed", taskId: freshTask.id, message: result.message };
    }

    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: "merge",
      taskId: freshTask.id,
      summary: `Merged ${freshTask.branch} into ${this.config.developBranch}`,
    });

    await deleteBranch(freshTask.branch);
    await updateTask(freshTask.id, {
      status: "completed",
      worktree: undefined,
      branch: undefined,
    });

    return { status: "merged", taskId: freshTask.id, message: result.message };
  }

  private async cleanupTaskArtifacts(task: Task): Promise<CleanupArtifactsResult> {
    let removedWorktree = false;
    let removedBranch = false;

    if (task.worktree) {
      removedWorktree = await removeWorktree(task.worktree);
    }

    if (task.branch && ["completed", "failed", "rejected"].includes(task.status)) {
      removedBranch = await deleteBranch(task.branch).catch(() => false);
    }

    await updateTask(task.id, {
      worktree: undefined,
      branch: removedBranch ? undefined : task.branch,
    });

    return { taskId: task.id, removedWorktree, removedBranch };
  }

  private async handleFailedTasks(): Promise<void> {
    const tasks = await loadTasks();
    const failedTasks = tasks.filter(
      (task) => task.status === "failed" || task.status === "rejected",
    );

    for (const task of failedTasks) {
      await addFailedTask(task);
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: "task_failed",
        taskId: task.id,
        summary: `Task failed after ${task.attemptCount} attempts: ${task.description.slice(0, 100)}`,
      });

      const allTasks = await loadTasks();
      const remainingTasks = allTasks.filter((item) => item.id !== task.id);
      await saveTasks(remainingTasks);
    }
  }

  private async finalizeTaskWorktree(
    task: Task,
    status: Extract<Task["status"], "approved" | "failed" | "rejected">,
  ): Promise<void> {
    if (task.worktree) {
      await removeWorktree(task.worktree);
    }

    await updateTask(task.id, {
      status,
      worktree: undefined,
    });
  }

  private async getRecentDecisions(): Promise<string[]> {
    const history = await loadHistory();
    return history
      .filter((entry) => entry.type === "decision")
      .slice(-5)
      .map((entry) => entry.summary);
  }

  private emitMasterState(): void {
    this.emit("master:state", {
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
    } satisfies MasterStateEvent);
  }

  private checkControlFile(): void {
    const controlFile = getControlFilePath();
    try {
      if (!existsSync(controlFile)) return;
      const content = readFileSync(controlFile, "utf-8");
      const cmd = JSON.parse(content);
      this.clearControlFile();

      if (cmd.action === "pause") {
        this.pause();
      } else if (cmd.action === "resume") {
        this.resume();
      } else if (cmd.action === "stop") {
        void this.stop();
      }
    } catch {
      this.clearControlFile();
    }
  }

  private clearControlFile(): void {
    const controlFile = getControlFilePath();
    try {
      if (existsSync(controlFile)) unlinkSync(controlFile);
    } catch {
      // ignore
    }
  }

  private writeHealthFile(): void {
    const healthFile = getHealthFilePath();
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
          timestamp: new Date().toISOString(),
        }),
      );
    } catch {
      // Non-critical: health file is best-effort
    }
  }

  private async cleanupStaleWorktrees(): Promise<void> {
    const activeTasks = await loadTasks();
    const failedTasks = await loadFailedTasks();
    const activeWorktrees = new Set(
      activeTasks
        .filter(
          (task) =>
            task.worktree &&
            ["pending", "assigned", "running", "reviewing", "failed", "rejected"].includes(
              task.status,
            ),
        )
        .map((task) => task.worktree!),
    );
    for (const task of failedTasks.filter((item) => item.worktree)) {
      activeWorktrees.add(task.worktree!);
    }

    const allWorktrees = await listWorktrees();
    const worktreesDirName =
      this.config.worktreesDir.split("/").filter(Boolean).pop() || this.config.worktreesDir;
    const staleWorktrees = allWorktrees.filter(
      (worktree) => worktree.includes(worktreesDirName) && !activeWorktrees.has(worktree),
    );

    for (const worktree of staleWorktrees) {
      this.logger.info(`Cleaning up stale worktree: ${worktree}`);
      await removeWorktree(worktree);
    }
  }

  private async recoverStaleRuntimeState(): Promise<void> {
    const slaves = await loadSlaves();
    let slaveChanged = false;
    const recoveredSlaves = slaves.map((slave) => {
      if (slave.status !== "busy") return slave;
      slaveChanged = true;
      return { ...slave, status: "idle" as const, currentTask: undefined };
    });
    if (slaveChanged) {
      await saveSlaves(recoveredSlaves);
    }

    const tasks = await loadTasks();
    let taskChanged = false;
    const recoveredTasks = tasks.map((task) => {
      if (task.status !== "assigned" && task.status !== "running") return task;
      taskChanged = true;
      return {
        ...task,
        status: "pending" as const,
        updatedAt: new Date().toISOString(),
      };
    });
    if (taskChanged) {
      await saveTasks(recoveredTasks);
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: "decision",
        summary: "Recovered stale runtime state: reset assigned/running tasks and busy slaves",
      });
    }
  }
}
