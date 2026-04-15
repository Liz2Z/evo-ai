import type { Task } from '../types'

const ACTIVE_TASK_STATUSES = new Set<Task['status']>(['pending', 'running', 'reviewing'])

const LOW_VALUE_DESCRIPTION_PATTERNS: RegExp[] = [
  /auto[-\s]?generated/i,
  /add a comment\b/i,
  /at the top of (any|each).*\.(ts|tsx|js|jsx)\s+file/i,
  /if no .*\.ts files exist, create/i,
  /在.*\.(ts|tsx|js|jsx).*顶部添加注释/i,
]

const RELEVANCE_PATTERNS: RegExp[] = [
  /mission\s*link\s*:/i,
  /follow[-\s]?up\s+value\s*:/i,
  /任务关联\s*[:：]/,
  /与主任务关联\s*[:：]/,
  /后续价值\s*[:：]/,
  /why\s+this\s+directly\s+advances\s+the\s+mission/i,
]

const MAX_ACCEPTED_INSPECTOR_TASKS = 3

export interface SanitizedInspectorTasks {
  accepted: Task[]
  dropped: Array<{
    task: Task
    reason: 'empty_description' | 'low_value' | 'duplicate' | 'missing_relevance' | 'over_limit'
  }>
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function buildTaskSignature(task: Task): string {
  return `${task.type}:${normalizeText(task.description)}`
}

function isLowValueInspectorTask(task: Task): boolean {
  const description = task.description.trim()
  if (!description) return false
  return LOW_VALUE_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description))
}

function hasRelevanceContext(task: Task): boolean {
  const context = task.context?.trim()
  if (!context) return false
  return RELEVANCE_PATTERNS.some((pattern) => pattern.test(context))
}

export function sanitizeInspectorTasks(
  incomingTasks: Task[],
  existingTasks: Task[],
): SanitizedInspectorTasks {
  const existingSignatures = new Set(
    existingTasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).map(buildTaskSignature),
  )

  const accepted: Task[] = []
  const dropped: SanitizedInspectorTasks['dropped'] = []
  const incomingSeen = new Set<string>()

  for (const task of incomingTasks) {
    const description = task.description.trim()
    if (!description) {
      dropped.push({ task, reason: 'empty_description' })
      continue
    }

    if (isLowValueInspectorTask(task)) {
      dropped.push({ task, reason: 'low_value' })
      continue
    }

    if (!hasRelevanceContext(task)) {
      dropped.push({ task, reason: 'missing_relevance' })
      continue
    }

    const signature = buildTaskSignature({ ...task, description })
    if (existingSignatures.has(signature) || incomingSeen.has(signature)) {
      dropped.push({ task, reason: 'duplicate' })
      continue
    }

    incomingSeen.add(signature)
    accepted.push({ ...task, description })
  }

  if (accepted.length > MAX_ACCEPTED_INSPECTOR_TASKS) {
    const kept = accepted
      .slice()
      .sort((left, right) => right.priority - left.priority)
      .slice(0, MAX_ACCEPTED_INSPECTOR_TASKS)
    const keptIds = new Set(kept.map((task) => task.id))
    for (const task of accepted) {
      if (!keptIds.has(task.id)) {
        dropped.push({ task, reason: 'over_limit' })
      }
    }
    return { accepted: kept, dropped }
  }

  return { accepted, dropped }
}
