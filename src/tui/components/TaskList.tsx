import { Box, Text, useInput } from 'ink'
import type React from 'react'
import type { Task } from '../../types'
import { GROUP_ORDER, getGroupedTaskIds, getGroupKey } from './taskListModel'

interface TaskListProps {
  tasks: Task[]
  selectedTaskId: string | null
  onSelect: (taskId: string | null) => void
  maxHeight: number
}

type TaskListLine = {
  content: React.ReactNode
  kind: 'spacer' | 'header' | 'task'
  taskId?: string
}

const TASK_PANEL_WIDTH = 31

const STATUS_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  running: { icon: '●', color: 'yellow', label: 'RUNNING' },
  pending: { icon: '○', color: 'gray', label: 'PENDING' },
  reviewing: { icon: '◆', color: 'cyan', label: 'REVIEWING' },
  completed: { icon: '✓', color: 'green', label: 'COMPLETED' },
  failed: { icon: '✗', color: 'red', label: 'FAILED' },
}

export function TaskList({ tasks, selectedTaskId, onSelect, maxHeight }: TaskListProps) {
  const flatIds = getGroupedTaskIds(tasks)
  const currentIndex = selectedTaskId ? flatIds.indexOf(selectedTaskId) : -1

  useInput((_input, key) => {
    if (key.upArrow && flatIds.length > 0) {
      const next = currentIndex > 0 ? currentIndex - 1 : 0
      onSelect(flatIds[next])
    } else if (key.downArrow && flatIds.length > 0) {
      const next = currentIndex < flatIds.length - 1 ? currentIndex + 1 : flatIds.length - 1
      onSelect(flatIds[next])
    }
  })

  const grouped = new Map<string, Task[]>()
  for (const task of tasks) {
    const key = getGroupKey(task.status)
    const group = grouped.get(key) || []
    group.push(task)
    grouped.set(key, group)
  }

  const lines: TaskListLine[] = []
  for (const status of GROUP_ORDER) {
    const group = grouped.get(status)
    if (!group || group.length === 0) continue
    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending

    if (lines.length > 0) lines.push({ kind: 'spacer', content: <Text> </Text> })
    lines.push({
      kind: 'header',
      content: (
        <Box width={TASK_PANEL_WIDTH}>
          <Text bold color={cfg.color} wrap="truncate-end">
            {cfg.label} ({group.length})
          </Text>
        </Box>
      ),
    })

    for (const task of group) {
      lines.push({
        kind: 'task',
        taskId: task.id,
        content: (
          <Box width={TASK_PANEL_WIDTH}>
            <Text>{task.id === selectedTaskId ? '> ' : '  '}</Text>
            <Text color={cfg.color}>{cfg.icon}</Text>
            <Text> </Text>
            <Text color={task.id === selectedTaskId ? 'white' : 'gray'} wrap="truncate-end">
              {task.description}
            </Text>
          </Box>
        ),
      })
    }
  }

  let visibleLines = lines
  if (lines.length > maxHeight) {
    const selectedIdx = lines.findIndex((l) => l.taskId === selectedTaskId)
    const half = Math.floor(maxHeight / 2)
    let start = Math.max(0, (selectedIdx >= 0 ? selectedIdx : 0) - half)
    const end = Math.min(lines.length, start + maxHeight)
    start = Math.max(0, end - maxHeight)
    while (start < lines.length && lines[start]?.kind === 'spacer') {
      start++
    }

    visibleLines = lines.slice(start, end)

    if (visibleLines.length > 0 && visibleLines[0]?.kind !== 'header') {
      let headerIdx = start - 1
      while (headerIdx >= 0 && lines[headerIdx]?.kind !== 'header') {
        headerIdx--
      }

      if (headerIdx >= 0) {
        visibleLines = [lines[headerIdx], ...visibleLines.slice(0, Math.max(0, maxHeight - 1))]
      }
    }
  }

  return (
    <Box flexDirection="column" width="100%">
      {visibleLines.map((line, i) => (
        <Box key={i}>{line.content}</Box>
      ))}
      {tasks.length === 0 && <Text color="gray">No tasks yet. Waiting for inspection...</Text>}
    </Box>
  )
}
