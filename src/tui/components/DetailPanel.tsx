import { Box, Text } from 'ink'
import type React from 'react'
import type { LogEntry, SlaveInfo, Task } from '../../types'
import { isActiveTask } from './detailPanelModel'

interface DetailPanelProps {
  task: Task | null
  activeSlaves: SlaveInfo[]
  logs: LogEntry[]
  liveLogs: LogEntry[]
  showLogs: boolean
  maxHeight: number
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  assigned: 'yellow',
  running: 'yellow',
  reviewing: 'cyan',
  approved: 'green',
  completed: 'green',
  failed: 'red',
  rejected: 'red',
}

function formatTime(iso: string): string {
  if (!iso) return 'N/A'
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false })
}

function renderLogLine(entry: LogEntry, showSlaveId: boolean) {
  return (
    <Box>
      <Text color="gray">{formatTime(entry.timestamp)} </Text>
      {showSlaveId && <Text color="cyan">[{entry.slaveId.slice(-7)}] </Text>}
      <Text color={entry.level === 'error' ? 'red' : entry.level === 'debug' ? 'gray' : 'white'}>
        {entry.message}
      </Text>
    </Box>
  )
}

function buildSummaryLines(task: Task, activeSlaves: SlaveInfo[]): React.ReactNode[] {
  const lines: React.ReactNode[] = []

  lines.push(
    <Box>
      <Text bold>TASK: </Text>
      <Text bold color="cyan">
        {task.id.slice(-7)}
      </Text>
      <Text> Status: </Text>
      <Text bold color={STATUS_COLORS[task.status] || 'white'}>
        {task.status}
      </Text>
      <Text>
        {' '}
        Type: {task.type} Pri: {task.priority}
      </Text>
    </Box>,
  )

  if (task.branch) {
    lines.push(
      <Text>
        Branch: <Text color="cyan">{task.branch}</Text>
      </Text>,
    )
  }
  if (task.worktree) {
    lines.push(
      <Text>
        Worktree: <Text color="gray">{task.worktree}</Text>
      </Text>,
    )
  }
  if (task.attemptCount > 0) {
    lines.push(
      <Text>
        Attempts: {task.attemptCount}/{task.maxAttempts}
      </Text>,
    )
  }

  lines.push(<Text bold>Description:</Text>)
  lines.push(
    <Text>
      {task.description.slice(0, 120)}
      {task.description.length > 120 ? '...' : ''}
    </Text>,
  )

  if (activeSlaves.length > 0) {
    lines.push(<Text bold>Active slave{activeSlaves.length > 1 ? 's' : ''}:</Text>)
    activeSlaves.forEach((slave) => {
      lines.push(
        <Text>
          {slave.id} ({slave.type}) <Text color="yellow">{slave.status}</Text> since{' '}
          {formatTime(slave.startedAt || '')}
        </Text>,
      )
    })
  }

  if (task.reviewHistory.length > 0) {
    const last = task.reviewHistory[task.reviewHistory.length - 1]
    lines.push(
      <Text>
        Last review:{' '}
        <Text
          color={
            last.review.verdict === 'approve'
              ? 'green'
              : last.review.verdict === 'reject'
                ? 'red'
                : 'yellow'
          }
        >
          {last.review.verdict}
        </Text>{' '}
        (confidence: {last.review.confidence})
      </Text>,
    )
    lines.push(<Text color="gray"> {last.review.summary.slice(0, 100)}</Text>)
  }

  return lines
}

function renderFullLogView(task: Task, logs: LogEntry[], maxHeight: number) {
  const visibleLogs = logs.slice(-(maxHeight - 2))

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>LOG: </Text>
        <Text bold color="cyan">
          {task.id.slice(-7)}
        </Text>
        <Text color="gray"> ({logs.length} lines)</Text>
      </Box>
      <Box flexDirection="column">
        {visibleLogs.length === 0 ? (
          <Text color="gray">No logs yet...</Text>
        ) : (
          visibleLogs.map((entry, i) => <Box key={i}>{renderLogLine(entry, true)}</Box>)
        )}
      </Box>
    </Box>
  )
}

export function DetailPanel({
  task,
  activeSlaves,
  logs,
  liveLogs,
  showLogs,
  maxHeight,
}: DetailPanelProps) {
  if (!task) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="gray">Select a task to view details</Text>
      </Box>
    )
  }

  // Log view mode
  if (showLogs) {
    return renderFullLogView(task, logs, maxHeight)
  }

  const summaryLines = buildSummaryLines(task, activeSlaves)
  const showLiveLogs = isActiveTask(task)

  if (!showLiveLogs) {
    const visible = [...summaryLines, <Text color="gray">Press 'l' to view full logs</Text>].slice(
      0,
      maxHeight,
    )

    return (
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Box key={i}>{line}</Box>
        ))}
      </Box>
    )
  }

  const summaryHeight = Math.max(6, Math.min(summaryLines.length + 1, Math.floor(maxHeight * 0.45)))
  const logHeight = Math.max(4, maxHeight - summaryHeight - 1)
  const visibleSummary = summaryLines.slice(0, summaryHeight - 1)
  const showSlaveId = activeSlaves.length !== 1
  const visibleLiveLogs = liveLogs.slice(-(logHeight - 1))
  const liveTitle =
    activeSlaves.length === 0
      ? 'LIVE LOGS: waiting for active slave [live]'
      : activeSlaves.length === 1
        ? `LIVE LOGS: ${activeSlaves[0].id.slice(-7)} (${activeSlaves[0].type}) [live]`
        : `LIVE LOGS: ${activeSlaves.length} slaves [live]`

  return (
    <Box flexDirection="column">
      {visibleSummary.map((line, i) => (
        <Box key={`summary-${i}`}>{line}</Box>
      ))}
      <Box>
        <Text bold color="cyan">
          {liveTitle}
        </Text>
        <Text color="gray"> ({liveLogs.length} lines)</Text>
      </Box>
      {activeSlaves.length === 0 ? (
        <Text color="gray">Task is active, but no busy slave is currently attached.</Text>
      ) : visibleLiveLogs.length === 0 ? (
        <Text color="gray">Waiting for slave logs...</Text>
      ) : (
        visibleLiveLogs.map((entry, i) => (
          <Box key={`live-${i}`}>{renderLogLine(entry, showSlaveId)}</Box>
        ))
      )}
      <Box>
        <Text color="gray">Press 'l' to view full task logs</Text>
      </Box>
    </Box>
  )
}
