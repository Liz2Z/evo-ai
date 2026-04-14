#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { parseArgs } from 'node:util'
import { settings } from './config'

import { Master } from './master/scheduler'
import { getControlFilePath, getHealthFilePath, getRuntimeDataDir } from './runtime/paths'
import { startTUI } from './tui/index'
import type { Task } from './types'
import { branchExists, isGitRepo } from './utils/git'
import { Logger } from './utils/logger'
import { answerQuestion, loadFailedTasks, loadMasterState, loadTasks } from './utils/storage'

const logger = new Logger('CLI')

function resolveStartupMission(savedMission?: string, cliMission?: string): string {
  const mission = cliMission?.trim() || savedMission?.trim() || ''
  if (!mission) {
    throw new Error('Mission is required. Please specify it with --mission.')
  }
  return mission
}

// Helper to get string value from parsed args
function getString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      mission: {
        type: 'string',
        short: 'm',
      },
      interval: {
        type: 'string',
        short: 'i',
      },
      concurrency: {
        type: 'string',
        short: 'c',
      },
      config: {
        type: 'string',
      },
      pause: {
        type: 'boolean',
        short: 'p',
      },
      resume: {
        type: 'boolean',
        short: 'r',
      },
      cancel: {
        type: 'string',
      },
      add: {
        type: 'string',
        short: 'a',
      },
      answer: {
        type: 'string',
      },
      status: {
        type: 'boolean',
        short: 's',
      },
      tasks: {
        type: 'boolean',
        short: 't',
      },
      failed: {
        type: 'boolean',
        short: 'f',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
    strict: false,
  })

  if (values.help) {
    printHelp()
    process.exit(0)
  }

  // Status check mode
  if (values.status) {
    await printStatus()
    process.exit(0)
  }

  // List tasks mode
  if (values.tasks) {
    await printTasks()
    process.exit(0)
  }

  // List failed tasks mode
  if (values.failed) {
    await printFailedTasks()
    process.exit(0)
  }

  // Answer question mode
  const answerQuestionId = getString(values.answer)
  if (answerQuestionId && positionals[0]) {
    await answerQuestion(answerQuestionId, positionals[0])
    logger.info(`Answered question ${answerQuestionId}`)
    process.exit(0)
  }

  // Check if we're in a git repo
  if (!(await isGitRepo())) {
    logger.userError('Error: Not in a git repository. Please run from a git repo.')
    process.exit(1)
  }

  const config = settings.get()
  const savedState = await loadMasterState()

  // Apply command line overrides
  const cliMission = getString(values.mission)
  const interval = getString(values.interval)
  const concurrency = getString(values.concurrency)

  if (interval) {
    const parsed = parseInt(interval, 10)
    if (Number.isNaN(parsed) || parsed < 1) {
      logger.userError('Error: --interval must be a positive number (seconds).')
      process.exit(1)
    }
    config.heartbeatInterval = parsed * 1000
  }
  if (concurrency) {
    const parsed = parseInt(concurrency, 10)
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 20) {
      logger.userError('Error: --concurrency must be between 1 and 20.')
      process.exit(1)
    }
    config.maxConcurrency = parsed
  }

  if (!(await branchExists(config.developBranch))) {
    logger.userError(`Error: Configured develop branch does not exist: ${config.developBranch}`)
    process.exit(1)
  }

  let resolvedMission: string
  try {
    resolvedMission = resolveStartupMission(savedState.mission, cliMission)
  } catch (error) {
    logger.userError((error as Error).message)
    process.exit(1)
  }

  // Create and start master
  const master = new Master(config, resolvedMission)

  // Handle signals
  process.on('SIGINT', async () => {
    logger.info('\nShutting down...')
    await master.stop()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await master.stop()
    process.exit(0)
  })

  // Handle commands that require running master
  if (values.pause) {
    if (!(await isMasterHealthy())) {
      logger.error('Error: Master is not running.')
      process.exit(1)
    }
    sendControlCommand('pause')
    logger.info('Pause command sent to master.')
    process.exit(0)
  }

  if (values.resume) {
    if (!(await isMasterHealthy())) {
      logger.error('Error: Master is not running.')
      process.exit(1)
    }
    sendControlCommand('resume')
    logger.info('Resume command sent to master.')
    process.exit(0)
  }

  const cancelTaskId = getString(values.cancel)
  if (cancelTaskId) {
    await master.cancelTask(cancelTaskId)
    logger.info(`Cancelled task ${cancelTaskId}`)
    process.exit(0)
  }

  const addTaskDesc = getString(values.add)
  if (addTaskDesc) {
    const task = await master.addTaskManually(addTaskDesc)
    logger.info(`Created task ${task.id}: ${task.description}`)
    process.exit(0)
  }

  // Start master
  await master.start()

  // Start TUI dashboard
  const tuiInstance = startTUI({
    emitter: master,
    master,
    maxConcurrency: config.maxConcurrency,
    onQuit: async () => {
      await master.stop()
    },
  })

  // Handle signals with TUI cleanup
  const cleanup = async () => {
    await master.stop()
    tuiInstance.unmount()
    process.exit(0)
  }

  // Remove earlier signal handlers and replace with unified cleanup
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('SIGTERM')
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

function printHelp() {
  logger.userOutput(`
evo-ai - AI Supervision System

Usage:
  bun run src/index.ts [options]

Options:
  -m, --mission <text>      Set the master's mission
  -i, --interval <seconds>  Set heartbeat interval (default: 30)
  -c, --concurrency <n>     Set max concurrent slaves (default: 3)

Commands:
  -s, --status              Show master status
  -t, --tasks               List current tasks
  -f, --failed              List failed tasks
  -a, --add <description>   Add a new task manually
  --cancel <taskId>         Cancel a task
  --answer <questionId> <answer>  Answer a pending question
  -p, --pause               Pause the master
  -r, --resume              Resume the master
  -h, --help                Show this help

Examples:
  bun run src/index.ts -m "Improve test coverage to 80%"
  bun run src/index.ts --status
  bun run src/index.ts --add "Fix the login bug"
  bun run src/index.ts --tasks
`)
}

async function printStatus() {
  const state = await loadMasterState()
  const healthy = await isMasterHealthy()

  logger.userOutput('\n=== Master Status ===\n')
  logger.userOutput(`Running: ${healthy ? `Yes (PID: ${healthy ? getMasterPid() : 'N/A'})` : 'No'}`)
  logger.userOutput(`Mission: ${state.mission || 'Not set. Start with --mission <text>.'}`)
  logger.userOutput(`Current Phase: ${state.currentPhase}`)
  logger.userOutput(`Active Since: ${state.activeSince}`)
  logger.userOutput(`Last Heartbeat: ${state.lastHeartbeat || 'Never'}`)
  logger.userOutput(`Last Inspection: ${state.lastInspection || 'Never'}`)

  if (state.pendingQuestions.length > 0) {
    logger.userOutput('\nPending Questions:')
    state.pendingQuestions.forEach((q) => {
      logger.userOutput(`  [${q.id}] ${q.question}`)
    })
  }
}

function getMasterPid(): string {
  try {
    const health = JSON.parse(readFileSync(getHealthFilePath(), 'utf-8'))
    return String(health.pid ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

async function printTasks() {
  const tasks = await loadTasks()

  logger.userOutput('\n=== Current Tasks ===\n')

  if (tasks.length === 0) {
    logger.userOutput('No tasks found.')
    return
  }

  const byStatus = tasks.reduce(
    (acc, t) => {
      if (!acc[t.status]) acc[t.status] = []
      acc[t.status].push(t)
      return acc
    },
    {} as Record<string, Task[]>,
  )

  for (const [status, statusTasks] of Object.entries(byStatus)) {
    logger.userOutput(`\n[${status.toUpperCase()}] (${statusTasks.length})`)
    statusTasks.forEach((t) => {
      logger.userOutput(`  ${t.id} (p${t.priority}): ${t.description.slice(0, 60)}...`)
    })
  }
}

async function printFailedTasks() {
  const failed = await loadFailedTasks()

  logger.userOutput('\n=== Failed Tasks ===\n')

  if (failed.length === 0) {
    logger.userOutput('No failed tasks.')
    return
  }

  failed.forEach((t) => {
    logger.userOutput(`[${t.id}] Attempt ${t.attemptCount}/${t.maxAttempts}`)
    logger.userOutput(`  ${t.description}`)
    if (t.reviewHistory.length > 0) {
      const lastReview = t.reviewHistory[t.reviewHistory.length - 1]
      logger.userOutput(
        `  Last review: ${lastReview.review.verdict} - ${lastReview.review.summary}`,
      )
    }
    logger.userOutput('')
  })
}

function sendControlCommand(action: 'pause' | 'resume' | 'stop'): void {
  const dataDir = getRuntimeDataDir()
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }
  writeFileSync(
    getControlFilePath(),
    JSON.stringify({ action, timestamp: new Date().toISOString() }),
  )
}

async function isMasterHealthy(): Promise<boolean> {
  const healthFile = getHealthFilePath()
  if (!existsSync(healthFile)) return false
  try {
    const health = JSON.parse(readFileSync(healthFile, 'utf-8'))
    const pid = Number(health.pid)
    if (!Number.isFinite(pid) || pid <= 0) return false

    // Verify process still exists
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }

    const age = Date.now() - new Date(health.timestamp).getTime()
    const heartbeatInterval =
      Number(health.heartbeatInterval) || settings.heartbeatInterval.get() || 30000
    // Consider unhealthy if heartbeat is older than 2x configured interval (+5s grace)
    return age < heartbeatInterval * 2 + 5000
  } catch {
    return false
  }
}

main().catch((error) => logger.error(String(error)))
