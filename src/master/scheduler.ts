import { EventEmitter } from 'events';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import type { Task, Config, MasterState, ReviewResult, TaskResult } from '../types';
import {
  loadTasks, saveTasks, updateTask, addTask,
  loadMasterState, saveMasterState,
  loadSlaves, saveSlaves,
  addHistoryEntry, loadHistory,
  addFailedTask, loadFailedTasks
} from '../utils/storage';
import { mergeBranch, deleteBranch, removeWorktree, getDiff, listWorktrees } from '../utils/git';
import { runInspector, runWorker, runReviewer } from '../slave/launcher';
import type { HeartbeatTickEvent, TaskStatusChangeEvent, MasterStateEvent } from '../types/events';
import { getControlFilePath, getHealthFilePath } from '../runtime/paths';

export class Master extends EventEmitter {
  private config: Config;
  private state: MasterState;
  private activeSlaves: number = 0;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private tickPromise: Promise<void> | null = null;

  constructor(config: Config, mission: string) {
    super();
    this.config = config;
    this.state = {
      mission,
      currentPhase: 'initializing',
      lastHeartbeat: '',
      lastInspection: '',
      activeSince: new Date().toISOString(),
      pendingQuestions: [],
    };
  }

  async start(): Promise<void> {
    this.isRunning = true;

    // Load saved state
    const savedState = await loadMasterState();
    this.state = {
      ...savedState,
      mission: this.state.mission || savedState.mission,
    };
    this.isPaused = savedState.currentPhase === 'paused';

    console.log(`Master starting with mission: ${this.state.mission}`);
    console.log(`Heartbeat interval: ${this.config.heartbeatInterval}ms`);
    console.log(`Max concurrency: ${this.config.maxConcurrency}`);

    // Recover stale runtime state from previous unclean exit
    await this.recoverStaleRuntimeState();

    // Clean up stale worktrees from previous crashes
    await this.cleanupStaleWorktrees();

    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'decision',
      summary: `Master started with mission: ${this.state.mission}`,
    });

    // Clear any stale control file
    this.clearControlFile();

    await saveMasterState(this.state);

    // Run one tick immediately, then continue heartbeat loop
    this.tickPromise = this.tick().finally(() => {
      this.tickPromise = null;
      this.scheduleNextTick();
    });
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await saveMasterState(this.state);
    console.log('Master stopped');
  }

  pause(): void {
    this.isPaused = true;
    this.state.currentPhase = 'paused';
    this.writeHealthFile();
    this.emitMasterState();
    console.log('Master paused');
  }

  resume(): void {
    this.isPaused = false;
    if (this.state.currentPhase === 'paused') {
      this.state.currentPhase = 'idle';
    }
    this.writeHealthFile();
    this.emitMasterState();
    console.log('Master resumed');
    if (!this.tickPromise) {
      this.scheduleNextTick();
    }
  }

  private scheduleNextTick(): void {
    if (!this.isRunning) return;

    setTimeout(() => {
      this.tickPromise = this.tick().finally(() => {
        this.tickPromise = null;
        this.scheduleNextTick();
      });
    }, this.config.heartbeatInterval);
  }

  private async tick(): Promise<void> {
    // Check for control commands from CLI
    this.checkControlFile();

    if (this.isPaused) {
      // Keep health signal fresh while paused so CLI resume can still reach master
      this.writeHealthFile();
      return;
    }

    this.state.lastHeartbeat = new Date().toISOString();

    // Update health file for CLI health check
    this.writeHealthFile();

    const tasks = await loadTasks();
    const pendingCount = tasks.filter(t => t.status === 'pending').length;

    this.emit('heartbeat', {
      timestamp: this.state.lastHeartbeat,
      phase: this.state.currentPhase,
      activeSlaves: this.activeSlaves,
      pendingCount,
    } satisfies HeartbeatTickEvent);

    console.log(`\n[${new Date().toISOString()}] Heartbeat tick`);

    try {
      // 1. Check slave status
      await this.checkSlaves();

      // 2. Check if we should run inspector
      if (await this.shouldRunInspector()) {
        await this.runInspection();
      }

      // 3. Dispatch pending tasks to workers
      await this.dispatchWorkers();

      // 4. Process completed tasks (assign reviewers)
      await this.processCompletedTasks();

      // 5. Process review results
      await this.processReviewResults();

      // 6. Merge approved tasks
      await this.mergeApprovedTasks();

      // 7. Handle failed tasks
      await this.handleFailedTasks();

      // 8. Save state
      await saveMasterState(this.state);

    } catch (error) {
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'error',
        summary: `Tick error: ${error}`,
      });
    }
  }

  private async checkSlaves(): Promise<void> {
    const slaves = await loadSlaves();
    const busySlaves = slaves.filter(s => s.status === 'busy');
    
    this.activeSlaves = busySlaves.length;
    console.log(`Active slaves: ${this.activeSlaves}/${this.config.maxConcurrency}`);
  }

  private async shouldRunInspector(): Promise<boolean> {
    const tasks = await loadTasks();
    const pendingOrRunning = tasks.filter(t => 
      ['pending', 'assigned', 'running', 'reviewing'].includes(t.status)
    );

    // Run inspector when no tasks are pending/running
    if (pendingOrRunning.length > 0) {
      return false;
    }

    // Check if we recently ran inspection
    if (this.state.lastInspection) {
      const lastInspectTime = new Date(this.state.lastInspection).getTime();
      const minInterval = 5 * 60 * 1000; // 5 minutes minimum between inspections
      if (Date.now() - lastInspectTime < minInterval) {
        return false;
      }
    }

    return true;
  }

  private async runInspection(): Promise<void> {
    console.log('Running inspection...');
    this.state.currentPhase = 'inspecting';

    const recentDecisions = await this.getRecentDecisions();
    
    try {
      const newTasks = await runInspector(this.state.mission, recentDecisions);
      
      for (const task of newTasks) {
        await addTask(task);
        await addHistoryEntry({
          timestamp: new Date().toISOString(),
          type: 'task_created',
          taskId: task.id,
          summary: `Task created: ${task.description.slice(0, 100)}`,
        });
      }

      this.state.lastInspection = new Date().toISOString();
      console.log(`Inspection complete. Found ${newTasks.length} new tasks.`);
    } catch (error) {
      console.error('Inspection failed:', error);
    }
  }

  private async dispatchWorkers(): Promise<void> {
    if (this.activeSlaves >= this.config.maxConcurrency) {
      return;
    }

    const tasks = await loadTasks();
    const pendingTasks = tasks.filter(t => t.status === 'pending');
    
    const availableSlots = this.config.maxConcurrency - this.activeSlaves;
    const tasksToAssign = pendingTasks
      .sort((a, b) => b.priority - a.priority)
      .slice(0, availableSlots);

    for (const task of tasksToAssign) {
      if (this.activeSlaves >= this.config.maxConcurrency) break;
      
      await this.assignWorker(task);
    }
  }

  private async assignWorker(task: Task): Promise<void> {
    console.log(`Assigning worker to task ${task.id}`);

    await updateTask(task.id, { status: 'assigned' });
    this.emit('task:status_change', {
      taskId: task.id,
      fromStatus: task.status,
      toStatus: 'assigned',
      task,
    } satisfies TaskStatusChangeEvent);
    this.activeSlaves++;

    const recentDecisions = await this.getRecentDecisions();
    const baseBranch = this.config.developBranch;

    // Run worker in background
    runWorker(task, this.state.mission, recentDecisions, '', baseBranch)
      .then(async (result) => {
        if (result) {
          await this.handleWorkerResult(task, result);
        } else {
          await updateTask(task.id, { status: 'failed' });
        }
        this.activeSlaves--;
      })
      .catch(async (error) => {
        console.error(`Worker failed for task ${task.id}:`, error);
        await updateTask(task.id, { status: 'failed' });
        this.activeSlaves--;
      });
  }

  private async handleWorkerResult(task: Task, result: TaskResult): Promise<void> {
    if (result.status === 'completed') {
      const newStatus = 'reviewing' as const;
      await updateTask(task.id, {
        status: newStatus,
        worktree: result.worktree,
        branch: result.branch,
      });
      this.emit('task:status_change', {
        taskId: task.id,
        fromStatus: 'assigned',
        toStatus: newStatus,
        task: { ...task, status: newStatus, worktree: result.worktree, branch: result.branch },
      } satisfies TaskStatusChangeEvent);
      
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'task_completed',
        taskId: task.id,
        summary: `Task completed, pending review. ${result.summary.slice(0, 100)}`,
        details: { filesChanged: result.filesChanged },
      });
    } else {
      const newStatus = 'failed' as const;
      await updateTask(task.id, { status: newStatus });
      this.emit('task:status_change', {
        taskId: task.id,
        fromStatus: 'assigned',
        toStatus: newStatus,
        task: { ...task, status: newStatus },
      } satisfies TaskStatusChangeEvent);
    }
  }

  private async processCompletedTasks(): Promise<void> {
    const tasks = await loadTasks();
    const tasksNeedingReview = tasks.filter(t => t.status === 'reviewing');

    for (const task of tasksNeedingReview) {
      await this.assignReviewer(task);
    }
  }

  private async assignReviewer(task: Task): Promise<void> {
    if (!task.worktree || !task.branch) {
      console.log(`Task ${task.id} missing worktree info, skipping review`);
      await updateTask(task.id, { status: 'approved' }); // Auto-approve if no worktree
      return;
    }

    console.log(`Assigning reviewer to task ${task.id}`);
    
    const baseBranch = this.config.developBranch;
    const diff = await getDiff(task.branch, baseBranch, task.worktree);
    
    if (!diff) {
      console.log(`No changes to review for task ${task.id}`);
      await this.finalizeTaskWorktree(task, 'approved');
      return;
    }

    const recentDecisions = await this.getRecentDecisions();
    
    try {
      const result = await runReviewer(task, this.state.mission, recentDecisions, diff);
      
      if (result) {
        await this.handleReviewResult(task, result);
      }
    } catch (error) {
      console.error(`Review failed for task ${task.id}:`, error);
    }
  }

  private async handleReviewResult(task: Task, result: ReviewResult): Promise<void> {
    await addHistoryEntry({
      timestamp: new Date().toISOString(),
      type: 'review',
      taskId: task.id,
      summary: `Review: ${result.verdict} (${result.confidence}) - ${result.summary}`,
      details: { issues: result.issues, suggestions: result.suggestions },
    });

    const reviewEntry = {
      attempt: task.attemptCount + 1,
      slaveId: 'reviewer',
      review: result,
      timestamp: new Date().toISOString(),
    };

    if (result.verdict === 'approve') {
      const newStatus = 'approved' as const;
      await updateTask(task.id, {
        status: newStatus,
        attemptCount: task.attemptCount + 1,
        reviewHistory: [...task.reviewHistory, reviewEntry],
      });
      await this.finalizeTaskWorktree(task, newStatus);
      this.emit('task:status_change', {
        taskId: task.id,
        fromStatus: 'reviewing',
        toStatus: newStatus,
        task,
      } satisfies TaskStatusChangeEvent);
    } else if (result.verdict === 'reject' || task.attemptCount + 1 >= task.maxAttempts) {
      const newStatus = 'rejected' as const;
      await updateTask(task.id, {
        status: newStatus,
        attemptCount: task.attemptCount + 1,
        reviewHistory: [...task.reviewHistory, reviewEntry],
      });
      await this.finalizeTaskWorktree(task, newStatus);
      this.emit('task:status_change', {
        taskId: task.id,
        fromStatus: 'reviewing',
        toStatus: newStatus,
        task,
      } satisfies TaskStatusChangeEvent);
    } else {
      // Request changes - reassign to new worker
      const newAttemptCount = task.attemptCount + 1;
      const additionalContext = this.buildRetryContext(result);

      await updateTask(task.id, {
        status: 'pending',
        attemptCount: newAttemptCount,
        context: task.context ? `${task.context}\n\n${additionalContext}` : additionalContext,
        reviewHistory: [...task.reviewHistory, reviewEntry],
      });
      this.emit('task:status_change', {
        taskId: task.id,
        fromStatus: 'reviewing',
        toStatus: 'pending',
        task,
      } satisfies TaskStatusChangeEvent);
    }
  }

  private buildRetryContext(result: ReviewResult): string {
    let context = '## Previous Review Feedback\n\n';
    
    if (result.issues.length > 0) {
      context += '**Issues to fix:**\n' + result.issues.map(i => `- ${i}`).join('\n') + '\n\n';
    }
    
    if (result.suggestions.length > 0) {
      context += '**Suggestions:**\n' + result.suggestions.map(s => `- ${s}`).join('\n') + '\n\n';
    }
    
    context += `**Summary:** ${result.summary}\n`;
    
    return context;
  }

  private async processReviewResults(): Promise<void> {
    // This is handled in handleReviewResult
  }

  private async mergeApprovedTasks(): Promise<void> {
    const tasks = await loadTasks();
    const approvedTasks = tasks.filter(t => t.status === 'approved');

    for (const task of approvedTasks) {
      if (!task.branch) continue;

      console.log(`Merging task ${task.id}`);
      
      const baseBranch = this.config.developBranch;
      const result = await mergeBranch(task.branch, baseBranch);

      if (result.success) {
        await addHistoryEntry({
          timestamp: new Date().toISOString(),
          type: 'merge',
          taskId: task.id,
          summary: `Merged ${task.branch} into ${baseBranch}`,
        });

        // Clean up
        await deleteBranch(task.branch);

        // Mark as completed
        await updateTask(task.id, {
          status: 'completed',
          worktree: undefined,
          branch: undefined,
        });
        this.emit('task:status_change', {
          taskId: task.id,
          fromStatus: 'approved',
          toStatus: 'completed',
          task,
        } satisfies TaskStatusChangeEvent);
      } else {
        await addHistoryEntry({
          timestamp: new Date().toISOString(),
          type: 'error',
          taskId: task.id,
          summary: `Merge failed: ${result.message}`,
        });
        await updateTask(task.id, { status: 'failed' });
        this.emit('task:status_change', {
          taskId: task.id,
          fromStatus: 'approved',
          toStatus: 'failed',
          task,
        } satisfies TaskStatusChangeEvent);
      }
    }
  }

  private async handleFailedTasks(): Promise<void> {
    const tasks = await loadTasks();
    const failedTasks = tasks.filter(t => t.status === 'failed' || t.status === 'rejected');

    for (const task of failedTasks) {
      // Move to failed tasks file
      await addFailedTask(task);
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'task_failed',
        taskId: task.id,
        summary: `Task failed after ${task.attemptCount} attempts: ${task.description.slice(0, 100)}`,
      });

      // Remove from active tasks
      const allTasks = await loadTasks();
      const remainingTasks = allTasks.filter(t => t.id !== task.id);
      await saveTasks(remainingTasks);
    }
  }

  private async finalizeTaskWorktree(
    task: Task,
    status: Extract<Task['status'], 'approved' | 'failed' | 'rejected'>
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
    const decisions = history
      .filter(h => h.type === 'decision')
      .slice(-5)
      .map(h => h.summary);
    return decisions;
  }

  // Public methods for external control
  async addTaskManually(description: string, type: Task['type'] = 'other', priority = 3): Promise<Task> {
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
    };

    await addTask(task);
    return task;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = await updateTask(taskId, { status: 'failed' });
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
      type: 'decision',
      summary: `Mission updated: ${mission}`,
    });
  }

  private emitMasterState(): void {
    this.emit('master:state', {
      phase: this.state.currentPhase,
      mission: this.state.mission,
      lastHeartbeat: this.state.lastHeartbeat,
    } satisfies MasterStateEvent);
  }

  // --- Control file communication ---

  private checkControlFile(): void {
    const controlFile = getControlFilePath();
    try {
      if (!existsSync(controlFile)) return;
      const content = readFileSync(controlFile, 'utf-8');
      const cmd = JSON.parse(content);
      this.clearControlFile();

      if (cmd.action === 'pause') {
        this.pause();
      } else if (cmd.action === 'resume') {
        this.resume();
      } else if (cmd.action === 'stop') {
        this.stop();
      }
    } catch {
      // Invalid control file, ignore and remove
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
      writeFileSync(healthFile, JSON.stringify({
        pid: process.pid,
        phase: this.state.currentPhase,
        isPaused: this.isPaused,
        activeSlaves: this.activeSlaves,
        lastHeartbeat: this.state.lastHeartbeat,
        heartbeatInterval: this.config.heartbeatInterval,
        timestamp: new Date().toISOString(),
      }));
    } catch {
      // Non-critical: health file is best-effort
    }
  }

  // --- Stale worktree cleanup ---

  private async cleanupStaleWorktrees(): Promise<void> {
    const activeTasks = await loadTasks();
    const failedTasks = await loadFailedTasks();
    const activeWorktrees = new Set(
      activeTasks
        .filter(t => t.worktree && ['pending', 'assigned', 'running', 'reviewing', 'failed', 'rejected'].includes(t.status))
        .map(t => t.worktree!)
    );
    for (const task of failedTasks) {
      if (task.worktree) activeWorktrees.add(task.worktree);
    }

    const allWorktrees = await listWorktrees();
    const worktreesDirName = this.config.worktreesDir.split('/').filter(Boolean).pop() || this.config.worktreesDir;
    const staleWorktrees = allWorktrees.filter(w =>
      w.includes(worktreesDirName) && !activeWorktrees.has(w)
    );

    for (const wt of staleWorktrees) {
      console.log(`Cleaning up stale worktree: ${wt}`);
      await removeWorktree(wt);
    }
  }

  private async recoverStaleRuntimeState(): Promise<void> {
    // Reset stale busy slaves to idle
    const slaves = await loadSlaves();
    let slaveChanged = false;
    const recoveredSlaves = slaves.map(s => {
      if (s.status !== 'busy') return s;
      slaveChanged = true;
      return { ...s, status: 'idle' as const, currentTask: undefined };
    });
    if (slaveChanged) {
      await saveSlaves(recoveredSlaves);
    }

    // Reset stale in-flight tasks to pending so scheduler can re-dispatch
    const tasks = await loadTasks();
    let taskChanged = false;
    const recoveredTasks = tasks.map(t => {
      if (t.status !== 'assigned' && t.status !== 'running') return t;
      taskChanged = true;
      return {
        ...t,
        status: 'pending' as const,
        updatedAt: new Date().toISOString(),
      };
    });
    if (taskChanged) {
      await saveTasks(recoveredTasks);
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'decision',
        summary: 'Recovered stale runtime state: reset assigned/running tasks and busy slaves',
      });
    }
  }
}
