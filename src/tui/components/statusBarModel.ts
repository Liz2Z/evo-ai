import type { ManagerActivityEvent } from '../../types/events'

export interface MasterActivityItem {
  id: string
  kind: ManagerActivityEvent['kind']
  line: string
}

const MAX_MASTER_ACTIVITIES = 3
const STATUS_BAR_CONTENT_LINES = 6
const STATUS_BAR_BORDER_LINES = 2

export function getStatusBarHeight(): number {
  return STATUS_BAR_CONTENT_LINES + STATUS_BAR_BORDER_LINES
}

export function formatHeartbeatDisplay(params: {
  phase: string
  lastHeartbeat: string
  heartbeatIntervalMs: number
  now?: number
}): { remainingMs: number; display: string } {
  const { phase, lastHeartbeat, heartbeatIntervalMs, now = Date.now() } = params
  const total = formatDuration(heartbeatIntervalMs)

  if (phase === 'paused' || phase === 'stopped') {
    return { remainingMs: 0, display: `${phase}/${total}` }
  }

  if (!lastHeartbeat) {
    return { remainingMs: heartbeatIntervalMs, display: `--/${total}` }
  }

  const nextHeartbeatAt = new Date(lastHeartbeat).getTime() + heartbeatIntervalMs
  const remainingMs = Math.max(0, nextHeartbeatAt - now)
  return {
    remainingMs,
    display: `${formatDuration(remainingMs)}/${total}`,
  }
}

export function mergeMasterActivities(
  existing: MasterActivityItem[],
  event: ManagerActivityEvent,
): MasterActivityItem[] {
  const normalizedSummary = normalizeActivityText(event.summary)
  const nextItem: MasterActivityItem = {
    id: `${event.timestamp}|${event.kind}|${normalizedSummary}`,
    kind: event.kind,
    line: formatMasterActivity(event, normalizedSummary),
  }

  if (existing.some((item) => item.id === nextItem.id)) {
    return existing
  }

  return [nextItem, ...existing].slice(0, MAX_MASTER_ACTIVITIES)
}

function formatMasterActivity(event: ManagerActivityEvent, summary: string): string {
  if (event.kind === 'turn_started') {
    return `thinking: ${summary}`
  }
  if (event.kind === 'turn_completed') {
    return summary
  }
  if (event.kind === 'turn_skipped') {
    return `skipped: ${event.triggerReason} (${summary})`
  }
  return `failed: ${summary}`
}

function normalizeActivityText(text: string): string {
  return text
    .replace(/[`*_#>]+/g, ' ')
    .replace(/(^|\n)\s*-\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (seconds === 0) return `${minutes}m`
  return `${minutes}m ${seconds}s`
}
