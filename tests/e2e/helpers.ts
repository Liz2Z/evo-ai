// Auto-generated
import type { Task, TaskResult, ReviewResult } from '../../src/types';

/**
 * 创建测试用 Task
 */
export function createTestTask(overrides: Partial<Task> = {}): Task {
  const id = `test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  return {
    id,
    type: 'other',
    status: 'pending',
    priority: 3,
    description: 'Test task: add a hello comment to README.md',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 3,
    reviewHistory: [],
    ...overrides,
  };
}

/**
 * 创建一个简单的 worker 任务（给文件加注释）
 */
export function createSimpleWorkTask(workdir: string): Task {
  return createTestTask({
    type: 'fix',
    description: `Add a comment "// Auto-generated" at the top of any .ts file in the project. If no .ts files exist, create src/index.ts with that comment.`,
    context: `Working directory: ${workdir}`,
  });
}

/**
 * 等待条件满足或超时
 */
export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout after ${timeoutMs}ms`);
}

/**
 * 验证 TaskResult 结构
 */
export function assertTaskResult(result: unknown): asserts result is TaskResult {
  const r = result as TaskResult;
  if (!r || typeof r !== 'object') throw new Error('Result is not an object');
  if (typeof r.taskId !== 'string') throw new Error(`Invalid taskId: ${r.taskId}`);
  if (typeof r.status !== 'string') throw new Error(`Invalid status: ${r.status}`);
  if (typeof r.summary !== 'string') throw new Error('Invalid summary');
}

/**
 * 验证 ReviewResult 结构
 */
export function assertReviewResult(result: unknown): asserts result is ReviewResult {
  const r = result as ReviewResult;
  if (!r || typeof r !== 'object') throw new Error('Result is not an object');
  if (typeof r.taskId !== 'string') throw new Error(`Invalid taskId: ${r.taskId}`);
  if (!['approve', 'request_changes', 'reject'].includes(r.verdict)) {
    throw new Error(`Invalid verdict: ${r.verdict}`);
  }
  if (typeof r.confidence !== 'number') throw new Error('Invalid confidence');
  if (!Array.isArray(r.issues)) throw new Error('Invalid issues');
  if (!Array.isArray(r.suggestions)) throw new Error('Invalid suggestions');
}

/**
 * 生成测试 mission
 */
export function testMission(): string {
  return 'E2E test: validate slave agent capabilities on a simple codebase';
}

/**
 * 生成测试 recentDecisions
 */
export function testRecentDecisions(): string[] {
  return ['Running E2E tests to validate slave agent system'];
}
