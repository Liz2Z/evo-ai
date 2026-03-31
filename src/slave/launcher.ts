import { join, resolve } from 'path';
import { readFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SlaveType, Task, TaskResult, ReviewResult } from '../types';
import { addHistoryEntry, updateSlave } from '../utils/storage';
import { createWorktree, getDiff, getChangedFiles } from '../utils/git';
import { SlaveLogger } from '../utils/logger';
import type { LogMessageEvent } from '../types/events';

const PROMPTS_DIR = join(import.meta.dir, 'prompts');

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
      const basePrompt = loadPrompt(this.type);
      const contextPrompt = this.buildContextPrompt();
      const fullSystemPrompt = `${basePrompt}\n\n${contextPrompt}`;

      // For worker type, create worktree first
      if (this.type === 'worker' && this.options.baseBranch) {
        const worktreeResult = await createWorktree(this.task, this.options.baseBranch);
        if (worktreeResult) {
          this.worktreePath = worktreeResult.path;
          this.branch = worktreeResult.branch;
        }
      }

      // Execute using Claude Agent SDK
      this.log('info', `Starting ${this.type} slave ${this.slaveId}...`);
      console.log(`Starting ${this.type} slave ${this.slaveId}...`);

      const workingDir = this.worktreePath || this.options.worktreePath || process.cwd();

      // Build the task prompt
      const taskPrompt = this.buildTaskPrompt();

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

      // Run query using Claude Agent SDK
      let output = '';
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
            console.error(`Slave ${this.slaveId} error:`, (message as any).errors);
            output = JSON.stringify({
              status: 'failed',
              summary: (message as any).errors?.join('; ') || 'Unknown error',
              filesChanged: [],
            });
          }
        }
      }

      this.log('info', `${this.type} slave ${this.slaveId} completed`);
      console.log(`${this.type} slave ${this.slaveId} completed`);

      // Process result based on type
      if (this.type === 'reviewer') {
        return this.parseReviewResult(output);
      } else {
        return await this.parseTaskResult(output);
      }
    } catch (error) {
      this.log('error', `Slave ${this.slaveId} failed: ${error}`);
      console.error(`Slave ${this.slaveId} failed:`, error);
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
      const baseBranch = this.options.baseBranch || 'develop';
      diff = await getDiff(this.branch, baseBranch, this.worktreePath);
      filesChanged = await getChangedFiles(this.branch, baseBranch, this.worktreePath);
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
    await updateSlave(this.slaveId, {
      status: 'idle',
      currentTask: undefined,
    });
  }

  async cancel(): Promise<void> {
    await this.cleanup();
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
