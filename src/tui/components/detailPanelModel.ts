import type { SlaveInfo, Task } from '../../types'

const ACTIVE_TASK_STATUSES: Task['status'][] = ['running', 'reviewing']

export function isActiveTask(task: Task | null): boolean {
  if (!task) return false
  return ACTIVE_TASK_STATUSES.includes(task.status)
}

export function getActiveTaskSlaves(taskId: string | null, slaves: SlaveInfo[]): SlaveInfo[] {
  if (!taskId) return []

  return slaves
    .filter((slave) => slave.status === 'busy' && slave.currentTask === taskId)
    .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''))
}

export function getTaskFailureReason(task: Task): string | null {
  const contextFailure = extractFailureFromContext(task.context)
  if (contextFailure) return contextFailure

  const lastReview = task.reviewHistory[task.reviewHistory.length - 1]
  if (lastReview?.review.verdict === 'reject' && lastReview.review.summary.trim()) {
    return lastReview.review.summary.trim()
  }

  return null
}

function extractFailureFromContext(context?: string): string | null {
  if (!context) return null

  const matches = [...context.matchAll(/Failure:\s*([\s\S]*?)(?=\n[A-Z][^:\n]*:|\n## |\n$|$)/g)]
  const lastMatch = matches[matches.length - 1]
  const reason = lastMatch?.[1]?.replace(/\s+/g, ' ').trim()
  return reason || null
}
