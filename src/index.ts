#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
// Auto-generated
import { parseArgs } from 'util'
import { settings } from './config'

import { Master } from './master/scheduler'
import { getControlFilePath, getHealthFilePath, getRuntimeDataDir } from './runtime/paths'
import { startTUI } from './tui/index'
import type { Task } from './types'
import { branchExists, isGitRepo } from './utils/git'
import { answerQuestion, loadFailedTasks, loadMasterState, loadTasks } from './utils/storage'

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
    console.log(`Answered question ${answerQuestionId}`)
    process.exit(0)
  }

  // Check if we're in a git repo
  if (!(await isGitRepo())) {
    console.error('Error: Not in a git repository. Please run from a git repo.')
    process.exit(1)
  }

  const config = settings.get()
  const savedState = await loadMasterState()

  // Apply command line overrides
  const cliMission = getString(values.mission)
  const interval = getString(values.interval)
  const concurrency = getString(values.concurrency)

  if (interval) {
    const parsed = parseInt(interval)
    if (isNaN(parsed) || parsed < 1) {
      console.error('Error: --interval must be a positive number (seconds).')
      process.exit(1)
    }
    config.heartbeatInterval = parsed * 1000
  }
  if (concurrency) {
    const parsed = parseInt(concurrency)
    if (isNaN(parsed) || parsed < 1 || parsed > 20) {
      console.error('Error: --concurrency must be between 1 and 20.')
      process.exit(1)
    }
    config.maxConcurrency = parsed
  }

  if (!(await branchExists(config.developBranch))) {
    console.error(`Error: Configured develop branch does not exist: ${config.developBranch}`)
    process.exit(1)
  }

  let resolvedMission: string
  try {
    resolvedMission = resolveStartupMission(savedState.mission, cliMission)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }

  // Create and start master
  const master = new Master(config, resolvedMission)

  // Handle signals
  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
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
      console.error('Error: Master is not running.')
      process.exit(1)
    }
    sendControlCommand('pause')
    console.log('Pause command sent to master.')
    process.exit(0)
  }

  if (values.resume) {
    if (!(await isMasterHealthy())) {
      console.error('Error: Master is not running.')
      process.exit(1)
    }
    sendControlCommand('resume')
    console.log('Resume command sent to master.')
    process.exit(0)
  }

  const cancelTaskId = getString(values.cancel)
  if (cancelTaskId) {
    await master.cancelTask(cancelTaskId)
    console.log(`Cancelled task ${cancelTaskId}`)
    process.exit(0)
  }

  const addTaskDesc = getString(values.add)
  if (addTaskDesc) {
    const task = await master.addTaskManually(addTaskDesc)
    console.log(`Created task ${task.id}: ${task.description}`)
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
  console.log(`
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

  console.log('\n=== Master Status ===\n')
  console.log(
    `Running: ${healthy ? 'Yes (PID: ' + (healthy ? getMasterPid() : 'N/A') + ')' : 'No'}`,
  )
  console.log(`Mission: ${state.mission || 'Not set. Start with --mission <text>.'}`)
  console.log(`Current Phase: ${state.currentPhase}`)
  console.log(`Active Since: ${state.activeSince}`)
  console.log(`Last Heartbeat: ${state.lastHeartbeat || 'Never'}`)
  console.log(`Last Inspection: ${state.lastInspection || 'Never'}`)

  if (state.pendingQuestions.length > 0) {
    console.log('\nPending Questions:')
    state.pendingQuestions.forEach((q) => {
      console.log(`  [${q.id}] ${q.question}`)
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

  console.log('\n=== Current Tasks ===\n')

  if (tasks.length === 0) {
    console.log('No tasks found.')
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
    console.log(`\n[${status.toUpperCase()}] (${statusTasks.length})`)
    statusTasks.forEach((t) => {
      console.log(`  ${t.id} (p${t.priority}): ${t.description.slice(0, 60)}...`)
    })
  }
}

async function printFailedTasks() {
  const failed = await loadFailedTasks()

  console.log('\n=== Failed Tasks ===\n')

  if (failed.length === 0) {
    console.log('No failed tasks.')
    return
  }

  failed.forEach((t) => {
    console.log(`[${t.id}] Attempt ${t.attemptCount}/${t.maxAttempts}`)
    console.log(`  ${t.description}`)
    if (t.reviewHistory.length > 0) {
      const lastReview = t.reviewHistory[t.reviewHistory.length - 1]
      console.log(`  Last review: ${lastReview.review.verdict} - ${lastReview.review.summary}`)
    }
    console.log('')
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

main().catch(console.error)
