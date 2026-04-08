import { join, resolve } from 'path';
import { readFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SlaveType, Task, TaskResult, ReviewResult } from '../types';
import { addHistoryEntry, updateSlave } from '../utils/storage';
import { createWorktree, getDiff, getChangedFiles, removeWorktree } from '../utils/git';
import { SlaveLogger } from '../utils/logger';
import type { LogMessageEvent } from '../types/events';

const PROMPTS_DIR = join(import.meta.dir, 'prompts');

// Rate limiter: ensures minimum delay between API calls
class RateLimiter {
  private queue: Array<{ resolve: () => void }> = [];
  private running = 0;
  private lastFinish = 0;

  constructor(
    private maxConcurrent: number,
    private minIntervalMs: number,
  ) {}

  async acquire(): Promise<void> {
    // Enforce minimum interval between consecutive calls
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastFinish));
    if (wait > 0) {
      await new Promise<void>(r => setTimeout(r, wait));
    }

    if (this.running >= this.maxConcurrent) {
      await new Promise<void>(resolve => this.queue.push({ resolve }));
    }

    this.running++;
  }

  release(): void {
    this.running--;
    this.lastFinish = Date.now();
    const next = this.queue.shift();
    next?.resolve();
  }
}

const apiLimiter = new RateLimiter(2, 2000); // Max 2 concurrent, 2s between calls

function loadPrompt(type: SlaveType): string {
  const filename = `${type}.md`;
  return readFileSync(join(PROMPTS_DIR, filename), 'utf-8');
}

function generateTaskId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function generateSlaveId(type: SlaveType): string {
  return `${type}-${generateTaskId()}`;
}

function fallbackTitleFromTask(task: Task): string {
  return task.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join('-') || `task-${task.id.slice(-7)}`;
}

function sanitizeModelTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-_\s]+/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Load .env file and return env vars for SDK
function getEnvConfig(): Record<string, string | undefined> {
  // 优先使用 ENV_FILE 环境变量指定的文件，其次 .env.test（测试模式），最后 .env
  const envFile = process.env.ENV_FILE || (process.env.NODE_ENV === 'test' ? '.env.test' : '.env');
  const envPath = join(process.cwd(), envFile);
  const env: Record<string, string | undefined> = { ...process.env as Record<string, string | undefined> };

  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^(\w+)="?(.+?)"?$/);
      if (match) {
        env[match[1]] = match[2];
      }
    }
  } catch {
    // .env file not found, use process.env
  }

  return env;
}

export interface SlaveOptions {
  type: SlaveType;
  task: Task;
  mission: string;
  recentDecisions: string[];
  additionalContext?: string;
  worktreePath?: string;
  baseBranch?: string;
  logger?: SlaveLogger;
  onLog?: (event: LogMessageEvent) => void;
}

export class SlaveLauncher {
  private slaveId: string;
  private type: SlaveType;
  private task: Task;
  private worktreePath: string | null = null;
  private branch: string | null = null;
  private shouldRemoveWorktreeOnCleanup = false;
  private logger?: SlaveLogger;
  private onLog?: (event: LogMessageEvent) => void;

  constructor(private options: SlaveOptions) {
    this.slaveId = generateSlaveId(options.type);
    this.type = options.type;
    this.task = options.task;
    this.logger = options.logger;
    this.onLog = options.onLog;
  }

  private log(level: 'info' | 'error' | 'debug', message: string): void {
    const event: LogMessageEvent = {
      slaveId: this.slaveId,
      taskId: this.task.id,
      level,
      message,
      timestamp: new Date().toISOString(),
    };
    if (this.logger) {
      if (level === 'error') this.logger.error(message);
      else if (level === 'debug') this.logger.debug(message);
      else this.logger.info(message);
    }
    if (this.onLog) {
      this.onLog(event);
    }
  }

  async start(): Promise<{ slaveId: string }> {
    await updateSlave(this.slaveId, {
      id: this.slaveId,
      type: this.type,
      status: 'busy',
      currentTask: this.task.id,
      startedAt: new Date().toISOString(),
    });

    return { slaveId: this.slaveId };
  }

  async execute(): Promise<TaskResult | ReviewResult | null> {
    try {
      this.log('debug', `Preparing ${this.type} slave context`);
      const basePrompt = loadPrompt(this.type);
      const contextPrompt = this.buildContextPrompt();
      const fullSystemPrompt = `${basePrompt}\n\n${contextPrompt}`;

      // For worker type, create worktree first
      // Get env config from .env file
      const envConfig = getEnvConfig();

      // Map .env vars to SDK expected env vars
      const sdkEnv: Record<string, string | undefined> = {
        ...envConfig,
        // Map API_KEY to ANTHROPIC_API_KEY if not already set
        ANTHROPIC_API_KEY: envConfig.ANTHROPIC_API_KEY || envConfig.API_KEY,
        // Map BASE_URL to ANTHROPIC_BASE_URL if not already set
        ANTHROPIC_BASE_URL: envConfig.ANTHROPIC_BASE_URL || envConfig.BASE_URL,
      };

      if (this.type === 'worker' && this.options.baseBranch) {
        this.log('info', `Creating worktree from ${this.options.baseBranch}`);
        const semanticTitle = await this.generateWorktreeTitle(sdkEnv);
        const worktreeResult = await createWorktree(this.task, this.options.baseBranch, semanticTitle);
        if (worktreeResult) {
          this.worktreePath = worktreeResult.path;
          this.branch = worktreeResult.branch;
          this.shouldRemoveWorktreeOnCleanup = true;
          this.log('info', `Worktree ready: ${this.branch}`);
        } else {
          const message = `Failed to create worktree for task ${this.task.id}`;
          this.log('error', message);
          return {
            taskId: this.task.id,
            status: 'failed',
            worktree: '',
            branch: '',
            diff: '',
            summary: message,
            filesChanged: [],
            error: message,
          } as TaskResult;
        }
      }

      // Execute using Claude Agent SDK
      this.log('info', `Starting ${this.type} slave ${this.slaveId}...`);

      const workingDir = this.worktreePath || this.options.worktreePath || process.cwd();

      // Build the task prompt
      const taskPrompt = this.buildTaskPrompt();

      // Rate limit the API call
      await apiLimiter.acquire();
      let output = '';
      try {
        this.log('info', `Calling model for ${this.type} task`);
        const q = query({
          prompt: taskPrompt,
          options: {
            systemPrompt: fullSystemPrompt,
            cwd: resolve(workingDir),
            env: sdkEnv,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            maxTurns: this.type === 'inspector' ? 10 : 20,
          },
        });

        for await (const message of q) {
          if (message.type === 'result') {
            if (message.subtype === 'success') {
              output = message.result;
            } else {
              const errMsg = (message as any).errors?.join('; ') || 'Unknown error';
              this.log('error', `Slave ${this.slaveId} error: ${errMsg}`);
              output = JSON.stringify({
                status: 'failed',
                summary: (message as any).errors?.join('; ') || 'Unknown error',
                filesChanged: [],
              });
            }
          }
        }
      } finally {
        apiLimiter.release();
      }

      this.log('debug', `Model returned ${output.length} chars`);
      this.log('info', `${this.type} slave ${this.slaveId} completed`);

      // Process result based on type
      if (this.type === 'reviewer') {
        this.log('debug', 'Parsing review result');
        return this.parseReviewResult(output);
      } else {
        this.log('debug', 'Parsing task result');
        const result = await this.parseTaskResult(output);
        if (this.type === 'worker' && result.status === 'completed') {
          this.shouldRemoveWorktreeOnCleanup = false;
        }
        return result;
      }
    } catch (error) {
      this.log('error', `Slave ${this.slaveId} failed: ${error}`);
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'error',
        taskId: this.task.id,
        slaveId: this.slaveId,
        summary: `Slave execution failed: ${error}`,
      });
      return null;
    } finally {
      await this.cleanup();
    }
  }

  private buildContextPrompt(): string {
    const { mission, recentDecisions, additionalContext } = this.options;

    let context = `## Main Mission\n${mission}\n\n`;

    if (recentDecisions.length > 0) {
      context += `## Recent Decisions\n${recentDecisions.map(d => `- ${d}`).join('\n')}\n\n`;
    }

    context += `## Current Task\n**Task ID:** ${this.task.id}\n**Type:** ${this.task.type}\n**Priority:** ${this.task.priority}\n\n**Description:**\n${this.task.description}\n\n`;

    if (this.task.context) {
      context += `## Additional Context\n${this.task.context}\n\n`;
    }

    if (additionalContext) {
      context += `## Previous Work / Feedback\n${additionalContext}\n\n`;
    }

    if (this.worktreePath) {
      context += `## Working Directory\nYour worktree is located at: ${this.worktreePath}\nBranch: ${this.branch}\n\n`;
    }

    return context;
  }

  private buildTaskPrompt(): string {
    if (this.type === 'inspector') {
      return `Please scan the codebase and identify issues or improvements. Output your findings as a JSON array of tasks.`;
    } else if (this.type === 'reviewer') {
      return `Please review the code changes and provide your assessment in the specified JSON format.`;
    } else {
      return `Please complete the assigned task. When done, provide a summary of what was done.`;
    }
  }

  private async parseTaskResult(output: string): Promise<TaskResult> {
    // Try to extract JSON from output
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          taskId: this.task.id,
          status: parsed.status || 'completed',
          worktree: this.worktreePath || '',
          branch: this.branch || '',
          diff: '',
          summary: parsed.summary || output,
          filesChanged: parsed.filesChanged || [],
        };
      }
    } catch {
      // JSON parsing failed, use raw output
    }

    // Get actual diff from git for worker tasks
    let diff = '';
    let filesChanged: string[] = [];
    if (this.worktreePath && this.branch) {
      this.log('debug', `Collecting diff for ${this.branch}`);
      const baseBranch = this.options.baseBranch || 'develop';
      diff = await getDiff(this.branch, baseBranch, this.worktreePath);
      filesChanged = await getChangedFiles(this.branch, baseBranch, this.worktreePath);
      this.log('debug', `Collected diff for ${filesChanged.length} file(s)`);
    }

    return {
      taskId: this.task.id,
      status: 'completed',
      worktree: this.worktreePath || '',
      branch: this.branch || '',
      diff,
      summary: output.slice(-1000),
      filesChanged,
    };
  }

  private parseReviewResult(output: string): ReviewResult {
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          taskId: this.task.id,
          verdict: parsed.verdict || 'request_changes',
          confidence: parsed.confidence || 0.5,
          summary: parsed.summary || '',
          issues: parsed.issues || [],
          suggestions: parsed.suggestions || [],
        };
      }
    } catch {
      // JSON parsing failed
    }

    // Default review result
    return {
      taskId: this.task.id,
      verdict: 'request_changes',
      confidence: 0.3,
      summary: 'Could not parse review output',
      issues: ['Failed to parse structured review output'],
      suggestions: [],
    };
  }

  private async cleanup(): Promise<void> {
    if (this.shouldRemoveWorktreeOnCleanup && this.worktreePath) {
      this.log('info', `Cleaning up worktree: ${this.worktreePath}`);
      await removeWorktree(this.worktreePath);
      this.worktreePath = null;
    }

    await updateSlave(this.slaveId, {
      status: 'idle',
      currentTask: undefined,
    });
  }

  async cancel(): Promise<void> {
    this.log('info', `${this.type} slave ${this.slaveId} cancelled`);
    this.shouldRemoveWorktreeOnCleanup = true;
    await this.cleanup();
  }

  private async generateWorktreeTitle(env: Record<string, string | undefined>): Promise<string> {
    if (!env.ANTHROPIC_API_KEY) {
      return fallbackTitleFromTask(this.task);
    }

    const prompt = [
      'Generate a short semantic title for a git worktree based on this task.',
      'Return ONLY a kebab-case slug, 3-8 words, lowercase, letters/numbers/hyphen only.',
      `Task description: ${this.task.description}`,
      this.task.context ? `Task context: ${this.task.context}` : '',
    ].filter(Boolean).join('\n');

    await apiLimiter.acquire();
    try {
      const queryOptions: any = {
        cwd: resolve(process.cwd()),
        env,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
      };
      if (process.env.WORKTREE_TITLE_MODEL) {
        queryOptions.model = process.env.WORKTREE_TITLE_MODEL;
      }

      const q = query({
        prompt,
        options: queryOptions,
      });

      let output = '';
      for await (const message of q) {
        if (message.type === 'result' && message.subtype === 'success') {
          output = message.result;
        }
      }

      const slug = sanitizeModelTitle(output.trim().split('\n')[0] || '');
      return slug || fallbackTitleFromTask(this.task);
    } catch {
      return fallbackTitleFromTask(this.task);
    } finally {
      apiLimiter.release();
    }
  }
}

// Convenience functions
export async function runInspector(mission: string, recentDecisions: string[]): Promise<Task[]> {
  const inspectorTask: Task = {
    id: 'inspection',
    type: 'other',
    status: 'running',
    priority: 1,
    description: 'Scan the codebase for issues and improvements',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 1,
    reviewHistory: [],
  };

  const launcher = new SlaveLauncher({
    type: 'inspector',
    task: inspectorTask,
    mission,
    recentDecisions,
  });

  await launcher.start();
  const result = await launcher.execute();

  // Parse tasks from inspector output
  if (result && 'summary' in result) {
    try {
      const parsed = JSON.parse(result.summary);
      if (Array.isArray(parsed.tasks)) {
        return parsed.tasks.map((t: Partial<Task>) => ({
          id: generateTaskId(),
          type: t.type || 'other',
          status: 'pending' as const,
          priority: t.priority || 3,
          description: t.description || '',
          context: t.context,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 3,
          reviewHistory: [],
        }));
      }
    } catch {
      // Try to find tasks in the raw output
      const taskMatch = result.summary.match(/"tasks"\s*:\s*\[[\s\S]*?\]/);
      if (taskMatch) {
        try {
          const tasksJson = JSON.parse(`{${taskMatch[0]}}`);
          if (Array.isArray(tasksJson.tasks)) {
            return tasksJson.tasks.map((t: Partial<Task>) => ({
              id: generateTaskId(),
              type: t.type || 'other',
              status: 'pending' as const,
              priority: t.priority || 3,
              description: t.description || '',
              context: t.context,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              attemptCount: 0,
              maxAttempts: 3,
              reviewHistory: [],
            }));
          }
        } catch {
          // Not valid JSON
        }
      }
    }
  }

  return [];
}

export async function runWorker(
  task: Task,
  mission: string,
  recentDecisions: string[],
  additionalContext: string,
  baseBranch: string
): Promise<TaskResult | null> {
  const launcher = new SlaveLauncher({
    type: 'worker',
    task,
    mission,
    recentDecisions,
    additionalContext,
    baseBranch,
  });

  await launcher.start();
  return launcher.execute() as Promise<TaskResult | null>;
}

export async function runReviewer(
  task: Task,
  mission: string,
  recentDecisions: string[],
  diff: string
): Promise<ReviewResult | null> {
  const launcher = new SlaveLauncher({
    type: 'reviewer',
    task,
    mission,
    recentDecisions,
    additionalContext: `## Code Changes to Review\n\`\`\`diff\n${diff}\n\`\`\``,
    worktreePath: task.worktree,
  });

  await launcher.start();
  return launcher.execute() as Promise<ReviewResult | null>;
}
