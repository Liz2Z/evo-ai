import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent'
import { createCodingTools, createReadOnlyTools } from '@mariozechner/pi-coding-agent'
import { createPiSession } from '../agent/pi'
import { getConfiguredModel, settings } from '../config'
import type { ReviewResult, SlaveType, Task, TaskResult } from '../types'
import type { LogMessageEvent } from '../types/events'
import { getUncommittedChangedFiles } from '../utils/git'
import type { SlaveLogger } from '../utils/logger'
import { Logger } from '../utils/logger'
import { addHistoryEntry, updateSlave } from '../utils/storage'

const PROMPTS_DIR = join(import.meta.dir, 'prompts')

class RateLimiter {
  private queue: Array<{ resolve: () => void }> = []
  private running = 0
  private lastFinish = 0

  constructor(
    private maxConcurrent: number,
    private minIntervalMs: number,
  ) {}

  async acquire(): Promise<void> {
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastFinish))
    if (wait > 0) {
      await new Promise<void>((r) => setTimeout(r, wait))
    }

    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push({ resolve }))
    }

    this.running++
  }

  release(): void {
    this.running--
    this.lastFinish = Date.now()
    const next = this.queue.shift()
    next?.resolve()
  }
}

const apiLimiter = new RateLimiter(1, 2000)

function loadPrompt(type: SlaveType): string {
  return readFileSync(join(PROMPTS_DIR, `${type}.md`), 'utf-8')
}

function generateTaskId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

function generateSlaveId(type: SlaveType): string {
  return `${type}-${generateTaskId()}`
}

function parseFirstJSONObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const parseObject = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  const direct = parseObject(trimmed)
  if (direct) return direct

  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of trimmed.matchAll(fencedRegex)) {
    const parsed = parseObject(match[1] || '')
    if (parsed) return parsed
  }

  const objectLike = trimmed.match(/\{[\s\S]*\}/)
  if (!objectLike) return null
  return parseObject(objectLike[0])
}

function mapPartialTaskToTask(t: Partial<Task>): Task {
  return {
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
  }
}

function truncateInline(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}

function stringifyToolValue(value: unknown, maxLength = 80): string {
  if (typeof value === 'string') {
    return truncateInline(value, maxLength)
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }

  if (Array.isArray(value)) {
    const preview = value
      .slice(0, 3)
      .map((item) => stringifyToolValue(item, 24))
      .join(', ')
    const suffix = value.length > 3 ? `, +${value.length - 3}` : ''
    return `[${preview}${suffix}]`
  }

  if (value && typeof value === 'object') {
    try {
      return truncateInline(JSON.stringify(value), maxLength)
    } catch {
      return '[object]'
    }
  }

  return String(value)
}

function formatToolInvocation(toolName: string, args: unknown): string {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}

  switch (toolName) {
    case 'bash': {
      const command = typeof input.command === 'string' ? input.command : ''
      return `bash(${truncateInline(command || '...', 100)})`
    }
    case 'read': {
      const path = typeof input.path === 'string' ? input.path : '?'
      const offset = typeof input.offset === 'number' ? `, offset=${input.offset}` : ''
      const limit = typeof input.limit === 'number' ? `, limit=${input.limit}` : ''
      return `read(${truncateInline(path, 80)}${offset}${limit})`
    }
    case 'edit': {
      const path = typeof input.path === 'string' ? input.path : '?'
      const edits = Array.isArray(input.edits) ? input.edits.length : 0
      return `edit(${truncateInline(path, 80)}${edits > 0 ? `, ${edits} edit${edits > 1 ? 's' : ''}` : ''})`
    }
    case 'write': {
      const path = typeof input.path === 'string' ? input.path : '?'
      return `write(${truncateInline(path, 80)})`
    }
    case 'grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '?'
      const path = typeof input.path === 'string' ? `, path=${input.path}` : ''
      const glob = typeof input.glob === 'string' ? `, glob=${input.glob}` : ''
      return `grep(${truncateInline(pattern, 60)}${truncateInline(path + glob, 40)})`
    }
    case 'find': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '?'
      const path = typeof input.path === 'string' ? `, path=${input.path}` : ''
      return `find(${truncateInline(pattern, 60)}${truncateInline(path, 40)})`
    }
    case 'ls': {
      const path = typeof input.path === 'string' ? input.path : '.'
      const limit = typeof input.limit === 'number' ? `, limit=${input.limit}` : ''
      return `ls(${truncateInline(path, 80)}${limit})`
    }
    default: {
      const entries = Object.entries(input).slice(0, 3)
      if (entries.length === 0) return toolName
      const summary = entries
        .map(([key, value]) => `${key}=${stringifyToolValue(value, 32)}`)
        .join(', ')
      return `${toolName}(${truncateInline(summary, 100)})`
    }
  }
}

function summarizeToolResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return typeof result === 'string' ? truncateInline(result, 120) : null
  }

  const record = result as Record<string, unknown>
  const textLike =
    typeof record.output === 'string'
      ? record.output
      : typeof record.stderr === 'string'
        ? record.stderr
        : typeof record.error === 'string'
          ? record.error
          : typeof record.message === 'string'
            ? record.message
            : null

  if (textLike) return truncateInline(textLike, 120)

  if (typeof record.exitCode === 'number') return `exitCode=${record.exitCode}`
  if (typeof record.code === 'number') return `code=${record.code}`

  return truncateInline(stringifyToolValue(record, 120), 120)
}

export interface SlaveOptions {
  type: SlaveType
  task: Task
  mission: string
  recentDecisions: string[]
  additionalContext?: string
  worktreePath?: string
  logger?: SlaveLogger
  onLog?: (event: LogMessageEvent) => void
  onError?: (error: unknown) => void
}

export class SlaveLauncher {
  private readonly slaveId: string
  private readonly type: SlaveType
  private readonly task: Task
  private readonly logger?: SlaveLogger
  private readonly onLog?: (event: LogMessageEvent) => void

  constructor(private options: SlaveOptions) {
    this.slaveId = generateSlaveId(options.type)
    this.type = options.type
    this.task = options.task
    this.logger = options.logger
    this.onLog = options.onLog
  }

  private log(
    level: 'info' | 'error' | 'debug',
    message: string,
    source: 'status' | 'agent_text' | 'tool_step' = 'status',
  ): void {
    const event: LogMessageEvent = {
      slaveId: this.slaveId,
      taskId: this.task.id,
      source,
      level,
      message,
      timestamp: new Date().toISOString(),
    }
    if (this.logger) {
      if (level === 'error') this.logger.error(message, source)
      else if (level === 'debug') this.logger.debug(message, source)
      else this.logger.info(message, source)
    }
    this.onLog?.(event)
  }

  async start(): Promise<{ slaveId: string }> {
    await updateSlave(this.slaveId, {
      id: this.slaveId,
      type: this.type,
      status: 'busy',
      currentTask: this.task.id,
      startedAt: new Date().toISOString(),
    })

    return { slaveId: this.slaveId }
  }

  async execute(): Promise<TaskResult | ReviewResult | null> {
    try {
      this.log('debug', `Preparing ${this.type} slave context`)
      const basePrompt = loadPrompt(this.type)
      const contextPrompt = this.buildContextPrompt()
      const fullSystemPrompt = `${basePrompt}\n\n${contextPrompt}`
      const workingDir = this.options.worktreePath || process.cwd()
      const taskPrompt = this.buildTaskPrompt()

      await apiLimiter.acquire()
      let output = ''
      let unsubscribe: (() => void) | null = null
      let textBuffer = ''
      const toolCallLabels = new Map<string, string>()
      const flushTextBuffer = (force = false) => {
        if (!textBuffer) return
        const lines = textBuffer.split('\n')
        textBuffer = force ? '' : (lines.pop() ?? '')
        for (const line of lines) {
          const message = line.trim()
          if (message) this.log('info', message, 'agent_text')
        }
      }
      const onSessionEvent = (event: AgentSessionEvent) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          textBuffer += event.assistantMessageEvent.delta
          flushTextBuffer(false)
          return
        }

        if (event.type === 'tool_execution_start') {
          const label = formatToolInvocation(event.toolName, event.args)
          toolCallLabels.set(event.toolCallId, label)
          this.log('info', `Tool start: ${label}`, 'tool_step')
          return
        }

        if (event.type === 'tool_execution_end') {
          const label = toolCallLabels.get(event.toolCallId) || event.toolName
          toolCallLabels.delete(event.toolCallId)
          const resultSummary = summarizeToolResult(event.result)
          this.log(
            event.isError ? 'error' : 'info',
            event.isError && resultSummary
              ? `Tool failed: ${label} -> ${resultSummary}`
              : `Tool ${event.isError ? 'failed' : 'done'}: ${label}`,
            'tool_step',
          )
          return
        }

        if (event.type === 'agent_end' || event.type === 'message_end') {
          flushTextBuffer(true)
        }
      }

      try {
        const config = this.getRunConfig()
        const modelId = getConfiguredModel(config, 'slave') || config.models.pro
        const cwd = resolve(workingDir)
        const tools = this.type === 'worker' ? createCodingTools(cwd) : createReadOnlyTools(cwd)
        const { session } = await createPiSession({
          cwd,
          config,
          modelId,
          tools,
        })
        unsubscribe = session.subscribe(onSessionEvent)
        await session.prompt(`${fullSystemPrompt}\n\n${taskPrompt}`)
        flushTextBuffer(true)
        output = session.getLastAssistantText() || ''
      } finally {
        if (unsubscribe) unsubscribe()
        apiLimiter.release()
      }

      this.log('debug', `Model returned ${output.length} chars`)
      if (this.type === 'reviewer') {
        return this.parseReviewResult(output)
      }
      return this.parseTaskResult(output)
    } catch (error) {
      this.options.onError?.(error)
      this.log('error', `Slave ${this.slaveId} failed: ${error}`)
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'error',
        taskId: this.task.id,
        slaveId: this.slaveId,
        summary: `Slave execution failed: ${error}`,
      })
      return null
    } finally {
      await this.cleanup()
    }
  }

  private getRunConfig() {
    return settings.get()
  }

  private buildContextPrompt(): string {
    const { mission, recentDecisions, additionalContext, worktreePath } = this.options

    let context = `## Main Mission\n${mission}\n\n`

    if (recentDecisions.length > 0) {
      context += `## Recent Decisions\n${recentDecisions.map((d) => `- ${d}`).join('\n')}\n\n`
    }

    context += `## Current Task\n**Task ID:** ${this.task.id}\n**Type:** ${this.task.type}\n**Priority:** ${this.task.priority}\n\n**Description:**\n${this.task.description}\n\n`

    if (this.task.context) {
      context += `## Additional Context\n${this.task.context}\n\n`
    }

    if (additionalContext) {
      context += `## Review Feedback / Extra Input\n${additionalContext}\n\n`
    }

    if (worktreePath) {
      context += `## Mission Workspace\nPath: ${worktreePath}\n\n`
    }

    return context
  }

  private buildTaskPrompt(): string {
    if (this.type === 'inspector') {
      return [
        'Inspect the code paths that matter most to the main mission and output ONLY valid JSON.',
        'Schema: {"tasks":[{"description":"...","type":"fix|feature|refactor|test|docs|other","priority":1-10,"context":"optional"}]}',
        'Return a raw JSON object only. Do not wrap with markdown code fences.',
        'Prioritize tasks that directly unblock, implement, or validate the main mission.',
        'If the mission core appears complete, you may propose 1-2 adjacent high-value follow-up tasks in the same area.',
        'Stay mission-scoped. Ignore unrelated cleanup, generic refactors, broad docs, dependency upgrades, and non-critical tests.',
        'Return at most 3 tasks. Prefer 1-2 if possible.',
        'Each task context must include either "Mission link:" or "Follow-up value:", plus concrete file/module scope.',
        "Never create low-value tasks that only add boilerplate comments or file headers (for example '// Auto-generated').",
        'Do not include markdown or explanations.',
      ].join('\n')
    }

    if (this.type === 'reviewer') {
      return [
        'Review the code changes and output ONLY valid JSON.',
        'Schema: {"verdict":"approve|request_changes|reject","confidence":0-1,"summary":"...","issues":["..."],"suggestions":["..."]}',
        'Do not include markdown or explanations.',
      ].join('\n')
    }

    return [
      'Complete the assigned task by editing files directly in the mission workspace.',
      'When finished, output ONLY valid JSON and stop.',
      'Schema: {"status":"completed|failed","summary":"...","filesChanged":["path1","path2"],"notes":"optional"}',
      'Do not ask follow-up questions. Make reasonable assumptions and proceed.',
      'Do not include markdown or explanations outside JSON.',
    ].join('\n')
  }

  private async parseTaskResult(output: string): Promise<TaskResult> {
    const parsed = parseFirstJSONObject(output)
    const inferredFiles = this.options.worktreePath
      ? await getUncommittedChangedFiles(this.options.worktreePath)
      : []

    if (parsed) {
      const status =
        typeof parsed.status === 'string' ? (parsed.status as TaskResult['status']) : 'completed'
      const summary =
        typeof parsed.summary === 'string' ? parsed.summary : JSON.stringify(parsed, null, 2)
      const filesChanged = Array.isArray(parsed.filesChanged)
        ? parsed.filesChanged.filter((item): item is string => typeof item === 'string')
        : inferredFiles

      return {
        taskId: this.task.id,
        status,
        summary,
        filesChanged,
        error: status === 'failed' ? summary : undefined,
      }
    }

    return {
      taskId: this.task.id,
      status: 'completed',
      summary: output.slice(-1000),
      filesChanged: inferredFiles,
    }
  }

  private parseReviewResult(output: string): ReviewResult {
    const parsed = parseFirstJSONObject(output)
    if (parsed) {
      return {
        taskId: this.task.id,
        verdict: (parsed.verdict as ReviewResult['verdict']) || 'request_changes',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        issues: Array.isArray(parsed.issues)
          ? parsed.issues.filter((item): item is string => typeof item === 'string')
          : [],
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions.filter((item): item is string => typeof item === 'string')
          : [],
      }
    }

    return {
      taskId: this.task.id,
      verdict: 'request_changes',
      confidence: 0.3,
      summary: 'Could not parse review output',
      issues: ['Failed to parse structured review output'],
      suggestions: [],
    }
  }

  private async cleanup(): Promise<void> {
    await updateSlave(this.slaveId, {
      status: 'idle',
      currentTask: undefined,
    })
  }

  async cancel(): Promise<void> {
    this.log('info', `${this.type} slave ${this.slaveId} cancelled`)
    await this.cleanup()
  }
}

export async function runInspector(mission: string, recentDecisions: string[]): Promise<Task[]> {
  const logger = new Logger('Inspector')
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
  }

  const launcher = new SlaveLauncher({
    type: 'inspector',
    task: inspectorTask,
    mission,
    recentDecisions,
    onError: (error) => logger.error(`Slave failed: ${error}`),
  })

  await launcher.start()
  const result = await launcher.execute()

  if (result && 'summary' in result) {
    const raw = result.summary
    const parsed = parseFirstJSONObject(raw)
    if (parsed && Array.isArray(parsed.tasks)) {
      const tasks = parsed.tasks.filter(
        (item): item is Partial<Task> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
      return tasks.map(mapPartialTaskToTask)
    }
  }

  const trimmedMission = mission.trim()
  if (!trimmedMission) return []

  return [
    {
      id: generateTaskId(),
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

export async function runWorker(
  task: Task,
  mission: string,
  recentDecisions: string[],
  additionalContext: string,
  worktreePath: string,
  onLog?: (event: LogMessageEvent) => void,
): Promise<TaskResult | null> {
  const launcher = new SlaveLauncher({
    type: 'worker',
    task,
    mission,
    recentDecisions,
    additionalContext,
    worktreePath,
    onLog,
  })

  await launcher.start()
  return launcher.execute() as Promise<TaskResult | null>
}

export async function runReviewer(
  task: Task,
  mission: string,
  recentDecisions: string[],
  diff: string,
  worktreePath: string,
  onLog?: (event: LogMessageEvent) => void,
): Promise<ReviewResult | null> {
  const launcher = new SlaveLauncher({
    type: 'reviewer',
    task,
    mission,
    recentDecisions,
    additionalContext: `## Code Changes to Review\n\`\`\`diff\n${diff}\n\`\`\``,
    worktreePath,
    onLog,
  })

  await launcher.start()
  return launcher.execute() as Promise<ReviewResult | null>
}
