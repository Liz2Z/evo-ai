import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionEngine } from '../../src/master/decision'
import {
  createMasterRuntime,
  MasterAgentAdapter,
  type MasterRuntime,
  type MasterRuntimeContext,
  type MasterSnapshot,
  type MasterTools,
} from '../../src/master/runtime'
import { Master } from '../../src/master/scheduler'
import type { Config, HistoryEntry, MasterState, Question, SlaveInfo, Task } from '../../src/types'

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
    pro: 'sonnet',
    max: 'opus',
  },
  provider: {},
  master: {
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

function runCmd(cmd: string, args: string[], cwd: string): void {
  const proc = Bun.spawnSync([cmd, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${proc.stderr.toString()}`)
  }
}

function createContext(mode: Config['master']['runtimeMode']): MasterRuntimeContext {
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
  const state: MasterState = {
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
  }
  const history: HistoryEntry[] = []
  const slaves: SlaveInfo[] = []

  return {
    triggerReason: 'test',
    timestamp: new Date().toISOString(),
    mission: 'make progress',
    config: { ...baseConfig, master: { ...baseConfig.master, runtimeMode: mode } },
    masterState: state,
    tasks: [pendingTask],
    slaves,
    recentHistory: history,
  }
}

function createNoopTools(): MasterTools {
  const snapshot: MasterSnapshot = {
    mission: 'make progress',
    runtimeMode: 'hybrid',
    currentPhase: 'idle',
    turnStatus: 'idle',
    activeSlaves: 0,
    maxConcurrency: 1,
    pendingCount: 1,
    pendingQuestions: [],
    lastHeartbeat: '',
    lastDecisionAt: '',
    skippedWakeups: 0,
    currentStage: 'idle',
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
    get_master_snapshot: async () => snapshot,
    list_tasks: async () => [task],
    list_slaves: async () => [],
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
    ask_human: async ({ question, options = [] }) => ({
      id: 'q-runtime',
      question,
      options,
      createdAt: new Date().toISOString(),
    }),
  }
}

describe('Master runtime driver', () => {
  test('运行中的 turn 会跳过新的唤醒请求', async () => {
    const runtimeFactory = () =>
      ({
        async init() {},
        async runTurn() {
          return {
            summary: 'turn',
            toolCalls: [],
            unauthorizedToolCalls: [],
          }
        },
        async dispose() {},
      }) satisfies MasterRuntime

    const master = new Master(baseConfig, 'test mission', { runtimeFactory })
    try {
      await master.start()
      ;(master as any).currentTurnPromise = new Promise(() => {})
      await (master as any).requestTurn('worker_completed')

      const state = master.getState()
      expect(state.skippedWakeups).toBe(1)
      expect(state.lastSkippedTriggerReason).toBe('worker_completed')
    } finally {
      ;(master as any).currentTurnPromise = null
      await master.stop()
    }
  })

  test('MasterAgentAdapter 只允许 MasterTools 白名单', async () => {
    const adapter = new MasterAgentAdapter(async () => ({ summary: 'ok' }))
    const tools = createNoopTools()

    await expect(adapter.callTool('list_tasks', { status: 'pending' }, tools)).resolves.toEqual([
      expect.objectContaining({ id: 'task-1' }),
    ])
    await expect(adapter.callTool('shell_exec', { cmd: 'pwd' }, tools)).rejects.toThrow(
      'Unauthorized master tool',
    )
  })

  test('三种 runtime 都能在同一套 MasterTools 上运行', async () => {
    const tools = createNoopTools()
    const agentExecutor = async () => ({
      summary: 'sdk master turn completed',
      sessionId: '00000000-0000-0000-0000-000000000001',
    })

    for (const mode of ['heartbeat_agent', 'session_agent', 'hybrid'] as const) {
      const context = createContext(mode)
      const runtime = createMasterRuntime(mode, context.config, context.masterState, {
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

    const runtime = createMasterRuntime('hybrid', context.config, context.masterState)
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
})
