import type { HistoryEntry, Task } from '../types'

export interface DecisionContext {
  mission: string
  recentHistory: HistoryEntry[]
  currentTasks: Task[]
  pendingQuestions: string[]
}

export interface Decision {
  action: 'continue' | 'pause' | 'ask_human' | 'create_task' | 'cancel_task'
  reason: string
  data?: {
    question?: string
    options?: string[]
    taskDescription?: string
    taskType?: Task['type']
    taskPriority?: number
    taskId?: string
  }
}

export class DecisionEngine {
  async decide(context: DecisionContext): Promise<Decision> {
    if (context.pendingQuestions.length > 0) {
      return {
        action: 'continue',
        reason: 'Waiting on existing human input while deterministic flow continues',
      }
    }

    const recentCompletions = context.recentHistory.filter(
      (h) => h.type === 'task_completed',
    ).length
    const recentFailures = context.recentHistory.filter(
      (h) => h.type === 'task_failed' || h.type === 'error',
    ).length

    if (recentFailures > 3 && recentFailures > recentCompletions) {
      return {
        action: 'ask_human',
        reason: 'High failure rate detected',
        data: {
          question: 'Multiple tasks are failing. Would you like to pause and review the failures?',
          options: ['Pause and review', 'Continue anyway', 'Reduce task complexity'],
        },
      }
    }

    if (!context.mission || context.mission.trim().length < 10) {
      return {
        action: 'ask_human',
        reason: 'Mission is not clearly defined',
        data: {
          question: 'Please provide a clear mission statement for the Master to follow.',
          options: [],
        },
      }
    }

    return {
      action: 'continue',
      reason: 'Normal operation',
    }
  }

  prioritizeTasks(tasks: Task[]): Task[] {
    return tasks.sort((a, b) => {
      const statusOrder = { running: 0, reviewing: 1, pending: 2, completed: 3, failed: 4 }
      const statusDiff =
        (statusOrder[a.status as keyof typeof statusOrder] || 99) -
        (statusOrder[b.status as keyof typeof statusOrder] || 99)
      if (statusDiff !== 0) return statusDiff
      return b.priority - a.priority
    })
  }

  shouldRetry(task: Task): boolean {
    return task.attemptCount < task.maxAttempts
  }

  shouldInspect(context: DecisionContext): boolean {
    const activeTasks = context.currentTasks.filter((t) =>
      ['pending', 'running', 'reviewing'].includes(t.status),
    )
    if (activeTasks.length > 0) return false

    const recentInspections = context.recentHistory.filter(
      (h) => h.type === 'decision' && h.summary.includes('launch_inspector'),
    )

    if (recentInspections.length > 0) {
      const lastInspection = recentInspections[recentInspections.length - 1]
      const timeSinceLastInspection = Date.now() - new Date(lastInspection.timestamp).getTime()
      if (timeSinceLastInspection < 5 * 60 * 1000) return false
    }

    return true
  }
}

export const decisionEngine = new DecisionEngine()
