import { join } from 'path';
import { readFileSync } from 'fs';
import type { SlaveType, SlaveInfo, Task, TaskResult, ReviewResult } from '../types';
import { addHistoryEntry, updateSlave } from '../utils/storage';
import { createWorktree, getDiff, getChangedFiles, removeWorktree } from '../utils/git';

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

export interface SlaveOptions {
  type: SlaveType;
  task: Task;
  mission: string;
  recentDecisions: string[];
  additionalContext?: string;
  worktreePath?: string;
  baseBranch?: string;
}

export class SlaveLauncher {
  private slaveId: string;
  private type: SlaveType;
  private task: Task;
  private worktreePath: string | null = null;
  private branch: string | null = null;

  constructor(private options: SlaveOptions) {
    this.slaveId = generateSlaveId(options.type);
    this.type = options.type;
    this.task = options.task;
  }

  async start(): Promise<{ slaveId: string; pid?: number }> {
    // Register slave
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
      const fullPrompt = `${basePrompt}\n\n${contextPrompt}`;

      // For worker type, create worktree
      if (this.type === 'worker') {
        const baseBranch = this.options.baseBranch || 'develop';
        const worktreeResult = await createWorktree(this.task, baseBranch);
        if (worktreeResult) {
          this.worktreePath = worktreeResult.path;
          this.branch = worktreeResult.branch;
        }
      }

      // Execute slave using pi CLI
      const result = await this.runPiCommand(fullPrompt);

      // Process result based on type
      if (this.type === 'reviewer') {
        return this.parseReviewResult(result);
      } else {
        return await this.parseTaskResult(result);
      }
    } catch (error) {
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

  private async runPiCommand(prompt: string): Promise<string> {
    const args = ['-p', prompt];

    // Run in worktree if available
    const cwd = this.worktreePath || process.cwd();

    console.log(`Starting slave ${this.slaveId} in ${cwd}...`);

    const proc = Bun.spawnSync(['pi', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 600000, // 10 minute timeout
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
    });

    if (proc.exitCode !== 0) {
      const error = proc.stderr.toString();
      console.error(`pi command failed: ${error}`);
      throw new Error(`pi command exited with code ${proc.exitCode}: ${error}`);
    }

    return proc.stdout.toString();
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

    // Get actual diff from git
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
      summary: output.slice(-1000), // Last 1000 chars
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
    // For workers, we might want to clean up worktree
    // but keeping it for now so we can review the partial work
    await this.cleanup();
  }
}

// Convenience functions
export async function runInspector(mission: string, recentDecisions: string[]): Promise<Task[]> {
  const slaveId = generateSlaveId('inspector');
  
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

  if (result && 'tasks' in result) {
    return (result as unknown as { tasks: Task[] }).tasks;
  }

  // Try to parse tasks from output
  if (result && 'summary' in result) {
    try {
      const parsed = JSON.parse(result.summary);
      if (Array.isArray(parsed.tasks)) {
        return parsed.tasks.map((t: Partial<Task>) => ({
          id: generateTaskId(),
          type: t.type || 'other',
          status: 'pending',
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
