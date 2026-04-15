const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

function toDate(value: string | Date): Date | null {
  const date = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(date.getTime()) ? null : date
}

function toBeijingIso(date: Date): string {
  return new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString()
}

export function getBeijingTimestamp(date: Date = new Date()): string {
  return `${toBeijingIso(date).slice(0, -1)}+08:00`
}

export function formatBeijingTime(
  value: string | Date,
  options?: { withMilliseconds?: boolean },
): string {
  const date = toDate(value)
  if (!date) return 'N/A'
  const time = toBeijingIso(date)
  return options?.withMilliseconds ? time.slice(11, 23) : time.slice(11, 19)
}

export function getTimestampValue(value: string): number {
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
}
