#!/usr/bin/env bun
import { parseArgs } from 'util';
import { Master } from './master/scheduler';
import { loadConfig, saveConfig, loadMasterState, addQuestion, answerQuestion, loadTasks, loadFailedTasks } from './utils/storage';
import { isGitRepo } from './utils/git';
import { startTUI } from './tui/index';
import type { Config, Task } from './types';

const DEFAULT_CONFIG: Config = {
  mission: 'Improve code quality and maintainability',
  heartbeatInterval: 30000,
  maxConcurrency: 3,
  maxRetryAttempts: 3,
  worktreesDir: '.worktrees',
  developBranch: 'develop',
  slaveCommand: 'pi',
};

// Helper to get string value from parsed args
function getString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  // Status check mode
  if (values.status) {
    await printStatus();
    process.exit(0);
  }

  // List tasks mode
  if (values.tasks) {
    await printTasks();
    process.exit(0);
  }

  // List failed tasks mode
  if (values.failed) {
    await printFailedTasks();
    process.exit(0);
  }

  // Answer question mode
  const answerQuestionId = getString(values.answer);
  if (answerQuestionId && positionals[0]) {
    await answerQuestion(answerQuestionId, positionals[0]);
    console.log(`Answered question ${answerQuestionId}`);
    process.exit(0);
  }

  // Check if we're in a git repo
  if (!await isGitRepo()) {
    console.error('Error: Not in a git repository. Please run from a git repo.');
    process.exit(1);
  }

  // Load or create config
  let config = await loadConfig();
  
  // Apply command line overrides
  const mission = getString(values.mission);
  const interval = getString(values.interval);
  const concurrency = getString(values.concurrency);
  
  if (mission) {
    config.mission = mission;
  }
  if (interval) {
    config.heartbeatInterval = parseInt(interval) * 1000;
  }
  if (concurrency) {
    config.maxConcurrency = parseInt(concurrency);
  }

  // Save config
  await saveConfig(config);

  // Create and start master
  const master = new Master(config);

  // Handle signals
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await master.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await master.stop();
    process.exit(0);
  });

  // Handle commands that require running master
  if (values.pause) {
    // TODO: Communicate with running master via file/state
    console.log('Pausing master...');
    process.exit(0);
  }

  if (values.resume) {
    console.log('Resuming master...');
    process.exit(0);
  }

  const cancelTaskId = getString(values.cancel);
  if (cancelTaskId) {
    await master.cancelTask(cancelTaskId);
    console.log(`Cancelled task ${cancelTaskId}`);
    process.exit(0);
  }

  const addTaskDesc = getString(values.add);
  if (addTaskDesc) {
    const task = await master.addTaskManually(addTaskDesc);
    console.log(`Created task ${task.id}: ${task.description}`);
    process.exit(0);
  }

  // Start master
  await master.start();

  // Start TUI dashboard
  const tuiInstance = startTUI({
    emitter: master,
    master,
    maxConcurrency: config.maxConcurrency,
    onQuit: async () => {
      await master.stop();
    },
  });

  // Handle signals with TUI cleanup
  const cleanup = async () => {
    await master.stop();
    tuiInstance.unmount();
    process.exit(0);
  };

  // Remove earlier signal handlers and replace with unified cleanup
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
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
`);
}

async function printStatus() {
  const state = await loadMasterState();
  const config = await loadConfig();
  
  console.log('\n=== Master Status ===\n');
  console.log(`Mission: ${state.mission || config.mission}`);
  console.log(`Current Phase: ${state.currentPhase}`);
  console.log(`Active Since: ${state.activeSince}`);
  console.log(`Last Heartbeat: ${state.lastHeartbeat || 'Never'}`);
  console.log(`Last Inspection: ${state.lastInspection || 'Never'}`);
  
  if (state.pendingQuestions.length > 0) {
    console.log('\nPending Questions:');
    state.pendingQuestions.forEach(q => {
      console.log(`  [${q.id}] ${q.question}`);
    });
  }
}

async function printTasks() {
  const tasks = await loadTasks();
  
  console.log('\n=== Current Tasks ===\n');
  
  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }

  const byStatus = tasks.reduce((acc, t) => {
    if (!acc[t.status]) acc[t.status] = [];
    acc[t.status].push(t);
    return acc;
  }, {} as Record<string, Task[]>);

  for (const [status, statusTasks] of Object.entries(byStatus)) {
    console.log(`\n[${status.toUpperCase()}] (${statusTasks.length})`);
    statusTasks.forEach(t => {
      console.log(`  ${t.id} (p${t.priority}): ${t.description.slice(0, 60)}...`);
    });
  }
}

async function printFailedTasks() {
  const failed = await loadFailedTasks();
  
  console.log('\n=== Failed Tasks ===\n');
  
  if (failed.length === 0) {
    console.log('No failed tasks.');
    return;
  }

  failed.forEach(t => {
    console.log(`[${t.id}] Attempt ${t.attemptCount}/${t.maxAttempts}`);
    console.log(`  ${t.description}`);
    if (t.reviewHistory.length > 0) {
      const lastReview = t.reviewHistory[t.reviewHistory.length - 1];
      console.log(`  Last review: ${lastReview.review.verdict} - ${lastReview.review.summary}`);
    }
    console.log('');
  });
}

main().catch(console.error);
