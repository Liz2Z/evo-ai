// Auto-generated
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

/**
 * Simple decision engine for Master
 * Currently returns basic decisions based on context
 * Can be extended to call LLM for more complex decisions
 */
export class DecisionEngine {
  async decide(context: DecisionContext): Promise<Decision> {
    // Check if we're making progress
    const recentCompletions = context.recentHistory.filter(
      (h) => h.type === 'task_completed' || h.type === 'merge',
    ).length

    const recentFailures = context.recentHistory.filter(
      (h) => h.type === 'task_failed' || h.type === 'error',
    ).length

    // If too many recent failures, ask for human guidance
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

    // Check if mission is still clear
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

    // Default: continue with normal operation
    return {
      action: 'continue',
      reason: 'Normal operation',
    }
  }

  /**
   * Prioritize tasks based on various factors
   */
  prioritizeTasks(tasks: Task[]): Task[] {
    return tasks.sort((a, b) => {
      // First by status (pending first)
      const statusOrder = { pending: 0, assigned: 1, running: 2, reviewing: 3 }
      const statusDiff =
        (statusOrder[a.status as keyof typeof statusOrder] || 99) -
        (statusOrder[b.status as keyof typeof statusOrder] || 99)
      if (statusDiff !== 0) return statusDiff

      // Then by priority (higher first)
      return b.priority - a.priority
    })
  }

  /**
   * Decide if a failed task should be retried
   */
  shouldRetry(task: Task): boolean {
    return task.attemptCount < task.maxAttempts
  }

  /**
   * Determine if inspection should run based on context
   */
  shouldInspect(context: DecisionContext): boolean {
    // Don't inspect if there are active tasks
    const activeTasks = context.currentTasks.filter((t) =>
      ['pending', 'assigned', 'running', 'reviewing'].includes(t.status),
    )

    if (activeTasks.length > 0) return false

    // Check recent history for inspection
    const recentInspections = context.recentHistory.filter(
      (h) => h.type === 'decision' && h.summary.includes('launch_inspector'),
    )

    // Don't inspect too frequently
    if (recentInspections.length > 0) {
      const lastInspection = recentInspections[recentInspections.length - 1]
      const timeSinceLastInspection = Date.now() - new Date(lastInspection.timestamp).getTime()
      const minInterval = 5 * 60 * 1000 // 5 minutes

      if (timeSinceLastInspection < minInterval) return false
    }

    return true
  }
}

// Singleton instance
export const decisionEngine = new DecisionEngine()
