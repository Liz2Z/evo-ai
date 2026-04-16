import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent'
import { createCodingTools, createReadOnlyTools } from '@mariozechner/pi-coding-agent'
import {
  abortPiSession,
  createPiSession,
  disposePiSession,
  type PiSessionLifecycle,
} from '../agent/pi'
import { getConfiguredModel, settings } from '../config'
import type { AgentRole, ReviewResult, Task, TaskResult } from '../types'
import type { LogMessageEvent } from '../types/events'
import { getUncommittedChangedFiles } from '../utils/git'
import type { AgentLogger } from '../utils/logger'
import { Logger } from '../utils/logger'
import { addHistoryEntry, updateAgent } from '../utils/storage'

const PROMPTS_DIR = join(import.meta.dir, 'prompts')
const CHILD_ENTRY_PATH = join(import.meta.dir, 'child.ts')

class RateLimiter {
  private queue: Array<{ resolve: () => void }> = []
  private running = 0
  private lastFinish = 0

  constructor(
    private maxConcurrent: number,
    private minIntervalMs: number,
    private maxQueueSize = 50,
  ) {}

  async acquire(): Promise<void> {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(
        `Rate limit queue full (${this.maxQueueSize} pending requests). Too many concurrent API calls.`,
      )
    }

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

function loadPrompt(type: AgentRole): string {
  return readFileSync(join(PROMPTS_DIR, `${type}.md`), 'utf-8')
}

function generateTaskId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

function generateAgentId(type: AgentRole): string {
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

export function parseInspectorTasksSummary(summary: string): Task[] {
  const parsed = parseFirstJSONObject(summary)
  if (!parsed || !Array.isArray(parsed.tasks)) return []
  const tasks = parsed.tasks.filter(
    (item): item is Partial<Task> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  )
  return tasks.map(mapPartialTaskToTask)
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

export interface AgentOptions {
  type: AgentRole
  task: Task
  mission: string
  recentDecisions: string[]
  baseBranch?: string
  additionalContext?: string
  worktreePath?: string
  logger?: AgentLogger
  onLog?: (event: LogMessageEvent) => void
  onError?: (error: unknown) => void
}

export type AgentExecutionResult = TaskResult | ReviewResult | null

export interface AgentHandle {
  start(): Promise<{ agentId: string }>
  execute(): Promise<AgentExecutionResult>
  cancel(): Promise<void>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  settled: boolean
}

interface ChildStdinSink {
  write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer): number
  flush(): number | Promise<number>
  end(error?: Error): number | Promise<number>
}

interface ChildProcessHandle {
  stdin: ChildStdinSink
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(): void
  exitCode: number | null
}

interface SlaveChildStartedMessage {
  type: 'started'
  agentId: string
  pid: number
}

interface SlaveChildLogMessage {
  type: 'log'
  event: LogMessageEvent
}

interface SlaveChildResultMessage {
  type: 'result'
  result: AgentExecutionResult
}

interface SlaveChildErrorMessage {
  type: 'error'
  message: string
  stack?: string
}

type AgentChildMessage =
  | SlaveChildStartedMessage
  | SlaveChildLogMessage
  | SlaveChildResultMessage
  | SlaveChildErrorMessage

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void
  let rejectFn!: (reason?: unknown) => void
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolveFn = (value) => {
        if (deferred.settled) return
        deferred.settled = true
        resolve(value)
      }
      rejectFn = (reason) => {
        if (deferred.settled) return
        deferred.settled = true
        reject(reason)
      }
    }),
    resolve: (value) => resolveFn(value),
    reject: (reason) => rejectFn(reason),
    settled: false,
  }
  return deferred
}

function shouldUseIsolatedSlaveProcess(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.EVO_AI_DISABLE_ISOLATED_SLAVES !== '1'
}

async function writeToChildStdin(
  stdin: ChildStdinSink,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    stdin.write(bytes)
    await stdin.flush()
  } finally {
    await stdin.end()
  }
}

async function consumeReadableStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onChunk(decoder.decode(value, { stream: true }))
    }
    const tail = decoder.decode()
    if (tail) onChunk(tail)
  } finally {
    reader.releaseLock()
  }
}

export class ProcessAgentLauncher implements AgentHandle {
  private subprocess?: ChildProcessHandle
  private readonly startDeferred = createDeferred<{ agentId: string }>()
  private readonly resultDeferred = createDeferred<AgentExecutionResult>()
  private stderrBuffer = ''
  private stdoutBuffer = ''
  private agentId?: string
  private started = false

  constructor(private readonly options: AgentOptions) {}

  async start(): Promise<{ agentId: string }> {
    if (this.started) {
      return this.startDeferred.promise
    }

    this.started = true
    const subprocess = Bun.spawn([process.execPath, 'run', CHILD_ENTRY_PATH], {
      cwd: process.cwd(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        EVO_AI_CHILD_SLAVE: '1',
      },
    })
    this.subprocess = subprocess

    void consumeReadableStream(subprocess.stdout, (chunk) => this.handleStdoutChunk(chunk))
    void consumeReadableStream(subprocess.stderr, (chunk) => {
      this.stderrBuffer += chunk
    })

    void subprocess.exited.then((exitCode: number) => {
      if (!this.startDeferred.settled) {
        this.startDeferred.reject(
          new Error(
            `Slave child exited before start (code=${exitCode})${this.stderrBuffer ? `: ${this.stderrBuffer.trim()}` : ''}`,
          ),
        )
      }
      if (!this.resultDeferred.settled) {
        this.resultDeferred.reject(
          new Error(
            `Slave child exited before result (code=${exitCode})${this.stderrBuffer ? `: ${this.stderrBuffer.trim()}` : ''}`,
          ),
        )
      }
    })

    try {
      await writeToChildStdin(subprocess.stdin, { options: this.options })
    } catch (error) {
      this.startDeferred.reject(error)
      this.resultDeferred.reject(error)
    }

    return this.startDeferred.promise
  }

  async execute(): Promise<AgentExecutionResult> {
    if (!this.started) {
      await this.start()
    }
    return this.resultDeferred.promise
  }

  async cancel(): Promise<void> {
    if (this.subprocess && this.subprocess.exitCode === null) {
      this.subprocess.kill()
      await this.subprocess.exited.catch(() => {})
    }

    if (this.agentId) {
      await updateAgent(this.agentId, {
        status: 'idle',
        currentTask: undefined,
        pid: undefined,
      })
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.handleChildMessage(trimmed)
    }
  }

  private handleChildMessage(line: string): void {
    let message: AgentChildMessage
    try {
      message = JSON.parse(line) as AgentChildMessage
    } catch {
      this.stderrBuffer += `${line}\n`
      return
    }

    if (message.type === 'started') {
      this.agentId = message.agentId
      this.startDeferred.resolve({ agentId: message.agentId })
      return
    }

    if (message.type === 'log') {
      this.options.onLog?.(message.event)
      return
    }

    if (message.type === 'result') {
      this.resultDeferred.resolve(message.result)
      return
    }

    this.startDeferred.reject(new Error(message.message))
    this.resultDeferred.reject(new Error(message.message))
  }
}

export function createAgentHandle(options: AgentOptions): AgentHandle {
  if (process.env.EVO_AI_CHILD_SLAVE === '1' || !shouldUseIsolatedSlaveProcess()) {
    return new AgentLauncher(options)
  }
  return new ProcessAgentLauncher(options)
}

export class AgentLauncher {
  private readonly agentId: string
  private readonly type: AgentRole
  private readonly task: Task
  private readonly logger?: AgentLogger
  private readonly onLog?: (event: LogMessageEvent) => void
  private activeSession?: PiSessionLifecycle

  constructor(private options: AgentOptions) {
    this.agentId = generateAgentId(options.type)
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
      agentId: this.agentId,
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

  async start(): Promise<{ agentId: string }> {
    await updateAgent(this.agentId, {
      id: this.agentId,
      type: this.type,
      status: 'busy',
      currentTask: this.task.id,
      startedAt: new Date().toISOString(),
    })

    return { agentId: this.agentId }
  }

  async execute(): Promise<TaskResult | ReviewResult | null> {
    try {
      this.log('debug', `Preparing ${this.type} agent context`)
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
        const modelId = getConfiguredModel(config, this.type) || config.models[this.type]
        const cwd = resolve(workingDir)
        const tools = this.type === 'worker' ? createCodingTools(cwd) : createReadOnlyTools(cwd)
        const { session } = await createPiSession({
          cwd,
          config,
          modelId,
          tools,
        })
        this.activeSession = session
        unsubscribe = session.subscribe(onSessionEvent)
        await session.prompt(`${fullSystemPrompt}\n\n${taskPrompt}`)
        flushTextBuffer(true)
        output = session.getLastAssistantText() || ''
      } finally {
        if (unsubscribe) unsubscribe()
        disposePiSession(this.activeSession)
        this.activeSession = undefined
        apiLimiter.release()
      }

      this.log('debug', `Model returned ${output.length} chars`)
      if (this.type === 'reviewer') {
        return this.parseReviewResult(output)
      }
      return this.parseTaskResult(output)
    } catch (error) {
      this.options.onError?.(error)
      this.log('error', `Slave ${this.agentId} failed: ${error}`)
      await addHistoryEntry({
        timestamp: new Date().toISOString(),
        type: 'error',
        taskId: this.task.id,
        agentId: this.agentId,
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
        '检查与主任务最相关的代码路径，只输出合法 JSON。',
        'Schema: {"tasks":[{"description":"...","type":"fix|feature|refactor|test|docs|other","priority":1-10,"context":"optional"}]}',
        '只返回原始 JSON 对象，不要使用 markdown code fence。',
        '任务 description 必须使用简体中文，禁止输出英文任务标题。',
        '优先输出直接阻塞、实现或验证主任务的事项。',
        '如果主任务核心已基本完成，可以补充 1-2 个同区域的高价值后续任务。',
        '保持 mission 范围内聚，忽略无关清理、泛化重构、宽泛文档、依赖升级和非关键测试。',
        '最多返回 3 个任务，优先返回 1-2 个。',
        '每个任务 context 必须使用中文，并包含“任务关联：”或“后续价值：”，同时写清楚具体文件、模块或代码路径。',
        '禁止创建只加样板注释、文件头注释之类的低价值任务。',
        '不要输出 markdown，不要附加解释。',
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
    await updateAgent(this.agentId, {
      status: 'idle',
      currentTask: undefined,
      pid: undefined,
    })
  }

  async cancel(): Promise<void> {
    this.log('info', `${this.type} agent ${this.agentId} cancelled`)
    await abortPiSession(this.activeSession)
    disposePiSession(this.activeSession)
    this.activeSession = undefined
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
    description: '检查代码库并生成后续任务',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 1,
    reviewHistory: [],
  }

  const launcher = createAgentHandle({
    type: 'inspector',
    task: inspectorTask,
    mission,
    recentDecisions,
    onError: (error) => logger.error(`Slave failed: ${error}`),
  })

  await launcher.start()
  const result = await launcher.execute()

  if (result && 'summary' in result) {
    const tasks = parseInspectorTasksSummary(result.summary)
    if (tasks.length > 0) return tasks
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
  const launcher = createAgentHandle({
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
  worktreePath?: string,
  onLog?: (event: LogMessageEvent) => void,
): Promise<ReviewResult | null> {
  const launcher = createAgentHandle({
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
