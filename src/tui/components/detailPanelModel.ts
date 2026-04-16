import type { SlaveInfo, Task } from '../../types'

const ACTIVE_TASK_STATUSES: Task['status'][] = ['running', 'reviewing']
const MIN_SUMMARY_SECTION_HEIGHT = 6
const MIN_LIVE_LOG_SECTION_HEIGHT = 6
const SUMMARY_SECTION_RATIO = 0.45

export interface DetailPanelSections {
  summarySectionHeight: number
  summaryBodyHeight: number
  liveLogSectionHeight: number
  liveLogBodyHeight: number
}

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

export function calculateDetailPanelSections(
  maxHeight: number,
  summaryLineCount: number,
): DetailPanelSections {
  const safeMaxHeight = Math.max(4, maxHeight)
  const maxSummarySectionHeight = Math.max(2, safeMaxHeight - MIN_LIVE_LOG_SECTION_HEIGHT)
  const preferredSummarySectionHeight = Math.min(
    summaryLineCount + 1,
    Math.max(2, Math.floor(safeMaxHeight * SUMMARY_SECTION_RATIO)),
  )

  const summarySectionHeight =
    maxSummarySectionHeight <= MIN_SUMMARY_SECTION_HEIGHT
      ? maxSummarySectionHeight
      : Math.min(
          maxSummarySectionHeight,
          Math.max(MIN_SUMMARY_SECTION_HEIGHT, preferredSummarySectionHeight),
        )

  const liveLogSectionHeight = Math.max(2, safeMaxHeight - summarySectionHeight)

  return {
    summarySectionHeight,
    summaryBodyHeight: Math.max(1, summarySectionHeight - 1),
    liveLogSectionHeight,
    liveLogBodyHeight: Math.max(1, liveLogSectionHeight - 1),
  }
}

function extractFailureFromContext(context?: string): string | null {
  if (!context) return null

  const matches = [...context.matchAll(/Failure:\s*([\s\S]*?)(?=\n[A-Z][^:\n]*:|\n## |\n$|$)/g)]
  const lastMatch = matches[matches.length - 1]
  const reason = lastMatch?.[1]?.replace(/\s+/g, ' ').trim()
  return reason || null
}
