import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionEngine } from '../../src/manager/decision'
import {
  buildManagerPrompt,
  buildManagerSystemPrompt,
  type CompleteMissionResult,
  createManagerRuntime,
  ManagerAgentAdapter,
  type ManagerRuntime,
  type ManagerRuntimeContext,
  type ManagerSnapshot,
  type ManagerTools,
} from '../../src/manager/runtime'
import { Manager } from '../../src/manager/scheduler'
import type { AgentInfo, Config, HistoryEntry, ManagerState, Question, Task } from '../../src/types'

const originalCwd = process.cwd()
let repoDir: string

const baseConfig: Config = {
  heartbeatInterval: 60_000,
  maxConcurrency: 1,
  maxRetryAttempts: 3,
  worktreesDir: '.worktrees',
  developBranch: 'main',
  models: {
    lite: 'haiku',
    inspector: 'haiku-inspector',
    worker: 'sonnet',
    reviewer: 'sonnet-review',
    manager: 'opus',
  },
  provider: {},
  manager: {
    runtimeMode: 'hybrid',
  },
}

beforeAll(async () => {
  repoDir = join(tmpdir(), `evo-ai-runtime-driver-${Date.now()}`)
  await mkdir(join(repoDir, '.worktrees'), { recursive: true })
  await mkdir(join(repoDir, '.evo-ai', '.data'), { recursive: true })
  await writeFile(join(repoDir, 'README.md'), '# runtime driver test repo\n')

  runCmd('git', ['init'], repoDir)
  runCmd('git', ['checkout', '-b', 'main'], repoDir)
  runCmd('git', ['config', 'user.email', 'test@evo-ai.dev'], repoDir)
  runCmd('git', ['config', 'user.name', 'Evo AI Test'], repoDir)
  runCmd('git', ['add', '-A'], repoDir)
  runCmd('git', ['commit', '-m', 'Initial commit'], repoDir)

  process.chdir(repoDir)
})

afterAll(async () => {
  process.chdir(originalCwd)
  await rm(repoDir, { recursive: true, force: true })
})

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function runCmd(cmd: string, args: string[], cwd: string): void {
  const proc = Bun.spawnSync([cmd, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${proc.stderr.toString()}`)
  }
}

function createContext(mode: Config['manager']['runtimeMode']): ManagerRuntimeContext {
  const pendingQuestion: Question = {
    id: 'q-1',
    question: 'test?',
    options: [],
    createdAt: new Date().toISOString(),
    answered: true,
    answer: 'ok',
  }
  const pendingTask: Task = {
    id: 'task-1',
    type: 'other',
    status: 'pending',
    priority: 3,
    description: 'implement something',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 3,
    reviewHistory: [],
  }
  const state: ManagerState = {
    mission: 'make progress',
    currentPhase: 'idle',
    lastHeartbeat: '',
    lastInspection: '',
    activeSince: new Date().toISOString(),
    pendingQuestions: [pendingQuestion],
    runtimeMode: mode,
    lastDecisionAt: '',
    turnStatus: 'idle',
    skippedWakeups: 0,
    currentStage: 'idle',
    pendingUserMessages: [],
  }
  const history: HistoryEntry[] = []
  const agents: AgentInfo[] = []

  return {
    triggerReason: 'test',
    timestamp: new Date().toISOString(),
    mission: 'make progress',
    config: { ...baseConfig, manager: { ...baseConfig.manager, runtimeMode: mode } },
    managerState: state,
    tasks: [pendingTask],
    agents,
    recentHistory: history,
    userMessages: [],
  }
}

function createNoopTools(): ManagerTools {
  const snapshot: ManagerSnapshot = {
    mission: 'make progress',
    runtimeMode: 'hybrid',
    currentPhase: 'idle',
    turnStatus: 'idle',
    activeAgents: 0,
    maxConcurrency: 1,
    pendingCount: 1,
    pendingQuestions: [],
    lastHeartbeat: '',
    lastDecisionAt: '',
    skippedWakeups: 0,
    currentStage: 'idle',
    pendingUserMessages: [],
  }
  const task: Task = {
    id: 'task-1',
    type: 'other',
    status: 'pending',
    priority: 3,
    description: 'implement something',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 3,
    reviewHistory: [],
  }

  return {
    get_manager_snapshot: async () => snapshot,
    list_tasks: async () => [task],
    list_agents: async () => [],
    get_task: async () => task,
    get_recent_history: async () => [],
    get_current_task_diff: async () => '',
    ensure_mission_workspace: async () => ({
      status: 'ready',
      path: '/tmp/mission',
      branch: 'mission/test',
      message: 'ok',
    }),
    launch_inspector: async () => ({ status: 'started', createdTaskIds: [], message: 'ok' }),
    assign_worker: async ({ taskId }) => ({ status: 'started', taskId, message: 'ok' }),
    assign_reviewer: async ({ taskId }) => ({ status: 'noop', taskId, message: 'ok' }),
    create_task: async ({ description, type = 'other', priority = 3, context }) => ({
      ...task,
      description,
      type,
      priority,
      context,
    }),
    update_task: async () => task,
    cancel_task: async ({ taskId }) => ({ status: 'cancelled', taskId }),
    retry_task: async ({ taskId }) => ({ status: 'retried', taskId }),
    commit_current_task: async () => ({ status: 'noop', taskId: task.id, message: 'ok' }),
    complete_mission: async (): Promise<CompleteMissionResult> => ({
      status: 'noop',
      message: 'ok',
    }),
    ask_human: async ({ question, options = [] }) => ({
      id: 'q-runtime',
      question,
      options,
      createdAt: new Date().toISOString(),
    }),
  }
}

describe('Manager runtime driver', () => {
  test('运行中的 turn 会跳过新的唤醒请求', async () => {
    const blocker = createDeferred<void>()
    const runtimeFactory = () =>
      ({
        async init() {},
        async runTurn() {
          await blocker.promise
          return {
            summary: 'turn',
            toolCalls: [],
            unauthorizedToolCalls: [],
          }
        },
        async dispose() {},
      }) satisfies ManagerRuntime

    const manager = new Manager(baseConfig, 'test mission', { runtimeFactory })
    try {
      ;(manager as any).isRunning = true
      const firstTurn = (manager as any).requestTurn('manual_test')
      await Promise.resolve()
      const pendingTurn = (manager as any).requestTurn('worker_completed')
      await Promise.resolve()

      const state = manager.getState()
      expect(state.skippedWakeups).toBe(1)
      expect(state.lastSkippedTriggerReason).toBe('worker_completed')
      blocker.resolve()
      await Promise.all([firstTurn, pendingTurn])
    } finally {
      blocker.resolve()
      await manager.stop()
    }
  })

  test('scheduler 会发出 manager:activity(turn_completed)', async () => {
    const runtimeFactory = () =>
      ({
        async init() {},
        async runTurn() {
          return {
            summary: 'Worker assigned to task-1',
            toolCalls: ['get_manager_snapshot', 'assign_worker'],
            unauthorizedToolCalls: [],
          }
        },
        async dispose() {},
      }) satisfies ManagerRuntime

    const manager = new Manager(baseConfig, 'test mission', { runtimeFactory })
    const events: Array<{
      kind: string
      triggerReason: string
      summary: string
      toolCalls: string[]
    }> = []
    manager.on('manager:activity', (event) => events.push(event))

    ;(manager as any).isRunning = true
    await (manager as any).executeTurn('manual_test')

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn_completed',
          triggerReason: 'manual_test',
          summary: 'Worker assigned to task-1',
          toolCalls: ['get_manager_snapshot', 'assign_worker'],
        }),
      ]),
    )
  })

  test('scheduler 会发出 manager:activity(turn_skipped)', async () => {
    const blocker = createDeferred<void>()
    const runtimeFactory = () =>
      ({
        async init() {},
        async runTurn() {
          await blocker.promise
          return {
            summary: 'turn',
            toolCalls: [],
            unauthorizedToolCalls: [],
          }
        },
        async dispose() {},
      }) satisfies ManagerRuntime

    const manager = new Manager(baseConfig, 'test mission', { runtimeFactory })
    const events: Array<{ kind: string; triggerReason: string; summary: string }> = []
    manager.on('manager:activity', (event) => events.push(event))

    ;(manager as any).isRunning = true
    const firstTurn = (manager as any).requestTurn('manual_test')
    await Promise.resolve()
    const pendingTurn = (manager as any).requestTurn('worker_completed')
    await Promise.resolve()

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn_skipped',
          triggerReason: 'worker_completed',
          summary: 'turn busy',
        }),
      ]),
    )

    blocker.resolve()
    await Promise.all([firstTurn, pendingTurn])
  })

  test('用户消息在当前 turn 结束后会立刻补跑，不等 heartbeat', async () => {
    const blocker = createDeferred<void>()
    const started = createDeferred<void>()
    const triggers: string[] = []
    let runCount = 0

    const runtimeFactory = () =>
      ({
        async init() {},
        async runTurn(context) {
          runCount += 1
          triggers.push(context.triggerReason)
          if (runCount === 1) {
            started.resolve()
            await blocker.promise
          }
          return {
            summary: `turn:${context.triggerReason}`,
            toolCalls: [],
            unauthorizedToolCalls: [],
          }
        },
        async dispose() {},
      }) satisfies ManagerRuntime

    const manager = new Manager(baseConfig, 'test mission', { runtimeFactory })
    ;(manager as any).isRunning = true

    const firstTurn = (manager as any).requestTurn('manual_test')
    await started.promise
    const userTurn = manager.sendMessageToManager('请立刻响应这条消息')

    blocker.resolve()
    await Promise.all([firstTurn, userTurn])

    expect(triggers).toEqual(['manual_test', 'user_message'])
  })

  test('ManagerAgentAdapter 只允许 ManagerTools 白名单', async () => {
    const adapter = new ManagerAgentAdapter(async () => ({ summary: 'ok' }))
    const tools = createNoopTools()

    await expect(adapter.callTool('list_tasks', { status: 'pending' }, tools)).resolves.toEqual([
      expect.objectContaining({ id: 'task-1' }),
    ])
    await expect(adapter.callTool('shell_exec', { cmd: 'pwd' }, tools)).rejects.toThrow(
      'Unauthorized manager tool',
    )
  })

  test('manager prompt 明确约束 mission 只能在 worktree 分支提交且禁止提前 merge', () => {
    const context = createContext('session_agent')
    context.managerState.missionBranch = 'mission/test'
    context.managerState.missionWorktree = '/tmp/mission'

    const systemPrompt = buildManagerSystemPrompt()
    const prompt = buildManagerPrompt(context, [])

    expect(systemPrompt).toContain(
      'All code changes for the mission must stay inside the current mission worktree on the mission branch.',
    )
    expect(systemPrompt).toContain('Do not commit task changes before reviewer approval.')
    expect(systemPrompt).toContain(
      'Do not merge mission work into main/manager/develop during task execution.',
    )
    expect(prompt).toContain(
      'All implementation changes must stay on the mission branch inside the mission worktree.',
    )
    expect(prompt).toContain('Only call commit_current_task after reviewer approval')
    expect(prompt).toContain(
      'Do not merge to main/manager/develop while the mission is still running.',
    )
  })

  test('三种 runtime 都能在同一套 ManagerTools 上运行', async () => {
    const tools = createNoopTools()
    const agentExecutor = async () => ({
      summary: 'sdk manager turn completed',
      sessionId: '00000000-0000-0000-0000-000000000001',
    })

    for (const mode of ['heartbeat_agent', 'session_agent', 'hybrid'] as const) {
      const context = createContext(mode)
      const runtime = createManagerRuntime(mode, context.config, context.managerState, {
        agentExecutor,
      })
      await runtime.init(context, tools)
      const result = await runtime.runTurn(context, tools)
      await runtime.dispose()

      expect(result.summary.length).toBeGreaterThan(0)
      expect(Array.isArray(result.toolCalls)).toBe(true)
      expect(result.unauthorizedToolCalls).toEqual([])
    }
  })

  test('hybrid 模式提问后仍会继续推进确定性调度', async () => {
    const context = createContext('hybrid')
    context.recentHistory = [
      { timestamp: new Date().toISOString(), type: 'error', summary: 'err-1' },
      { timestamp: new Date().toISOString(), type: 'error', summary: 'err-2' },
      { timestamp: new Date().toISOString(), type: 'error', summary: 'err-3' },
      { timestamp: new Date().toISOString(), type: 'error', summary: 'err-4' },
    ]

    const toolCalls: string[] = []
    const tools = createNoopTools()
    tools.ask_human = async ({ question, options = [] }) => {
      toolCalls.push(`ask_human:${question}`)
      return {
        id: 'q-runtime',
        question,
        options,
        createdAt: new Date().toISOString(),
      }
    }
    tools.assign_worker = async ({ taskId }) => {
      toolCalls.push(`assign_worker:${taskId}`)
      return { status: 'started', taskId, message: 'ok' }
    }

    const runtime = createManagerRuntime('hybrid', context.config, context.managerState)
    const result = await runtime.runTurn(context, tools)

    expect(result.toolCalls).toContain('ask_human')
    expect(result.toolCalls).toContain('assign_worker')
    expect(toolCalls).toEqual([
      'ask_human:Multiple tasks are failing. Would you like to pause and review the failures?',
      'assign_worker:task-1',
    ])
  })

  test('已有未回答问题时不会因为 decision engine 进入全局暂停', async () => {
    const decision = await decisionEngine.decide({
      mission: 'make progress',
      recentHistory: [],
      currentTasks: [],
      pendingQuestions: ['already asked'],
    })

    expect(decision.action).toBe('continue')
  })

  test('所有任务都已结束时优先 complete_mission，而不是再次 launch_inspector', async () => {
    const context = createContext('hybrid')
    context.tasks = [
      {
        ...context.tasks[0],
        status: 'completed',
      },
      {
        ...context.tasks[0],
        id: 'task-2',
        status: 'failed',
      },
    ]
    context.managerState.missionBranch = 'mission/test'
    context.managerState.missionWorktree = '/tmp/mission'

    const toolCalls: string[] = []
    const tools = createNoopTools()
    tools.get_manager_snapshot = async () => ({
      mission: context.mission,
      runtimeMode: 'hybrid',
      currentPhase: 'idle',
      turnStatus: 'idle',
      activeAgents: 0,
      maxConcurrency: 1,
      pendingCount: 0,
      pendingQuestions: [],
      lastHeartbeat: '',
      lastDecisionAt: '',
      skippedWakeups: 0,
      currentStage: 'idle',
      missionBranch: 'mission/test',
      missionWorktree: '/tmp/mission',
      pendingUserMessages: [],
    })
    tools.complete_mission = async () => {
      toolCalls.push('complete_mission')
      return { status: 'merged', message: 'ok' }
    }
    tools.launch_inspector = async () => {
      toolCalls.push('launch_inspector')
      return { status: 'started', createdTaskIds: [], message: 'unexpected' }
    }

    const runtime = createManagerRuntime('hybrid', context.config, context.managerState)
    const result = await runtime.runTurn(context, tools)

    expect(result.toolCalls).toContain('complete_mission')
    expect(toolCalls).toEqual(['complete_mission'])
    expect(result.summary).toContain('Mission merged into main')
  })
})
