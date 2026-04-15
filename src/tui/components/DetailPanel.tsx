import { Box, Text } from 'ink'
import type React from 'react'
import type { LogEntry, MasterState, SlaveInfo, Task } from '../../types'
import { getTaskFailureReason, isActiveTask } from './detailPanelModel'

interface DetailPanelProps {
  task: Task | null
  activeSlaves: SlaveInfo[]
  logs: LogEntry[]
  liveLogs: LogEntry[]
  showLogs: boolean
  maxHeight: number
  masterState?: MasterState | null
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  running: 'yellow',
  reviewing: 'cyan',
  completed: 'green',
  failed: 'red',
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

function prioritizeLiveLogs(logs: LogEntry[]): LogEntry[] {
  const primary = logs.filter((entry) => entry.source !== 'status')
  const secondary = logs.filter((entry) => entry.source === 'status')
  return [...primary, ...secondary]
}

function buildSummaryLines(
  task: Task,
  activeSlaves: SlaveInfo[],
  masterState?: MasterState | null,
): React.ReactNode[] {
  const lines: React.ReactNode[] = []

  lines.push(
    <Box key="task-header">
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

  if (masterState?.currentStage) {
    lines.push(
      <Text key="stage">
        Mission stage: <Text color="cyan">{masterState.currentStage}</Text>
      </Text>,
    )
  }
  if (masterState?.missionBranch) {
    lines.push(
      <Text key="branch">
        Mission branch: <Text color="cyan">{masterState.missionBranch}</Text>
      </Text>,
    )
  }
  if (masterState?.missionWorktree) {
    lines.push(
      <Text key="worktree">
        Mission worktree: <Text color="gray">{masterState.missionWorktree}</Text>
      </Text>,
    )
  }
  if (task.attemptCount > 0) {
    lines.push(
      <Text key="attempts">
        Review rounds: {task.attemptCount}/{task.maxAttempts}
      </Text>,
    )
  }

  lines.push(<Text key="desc-label">Description:</Text>)
  lines.push(
    <Text key="desc-text">
      {task.description.slice(0, 120)}
      {task.description.length > 120 ? '...' : ''}
    </Text>,
  )

  const failureReason = task.status === 'failed' ? getTaskFailureReason(task) : null
  if (failureReason) {
    lines.push(
      <Text key="failure-label" bold color="red">
        Failure reason:
      </Text>,
    )
    lines.push(
      <Text key="failure-text" color="red">
        {failureReason}
      </Text>,
    )
  }

  if (activeSlaves.length > 0) {
    lines.push(<Text key="slaves-label">Active slave{activeSlaves.length > 1 ? 's' : ''}:</Text>)
    activeSlaves.forEach((slave, idx) => {
      lines.push(
        <Text key={`slave-${slave.id}-${idx}`}>
          {slave.id} ({slave.type}) <Text color="yellow">{slave.status}</Text> since{' '}
          {formatTime(slave.startedAt || '')}
        </Text>,
      )
    })
  }

  if (task.reviewHistory.length > 0) {
    const last = task.reviewHistory[task.reviewHistory.length - 1]
    lines.push(
      <Text key="review-verdict">
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
    lines.push(<Text key="review-summary"> {last.review.summary.slice(0, 100)}</Text>)
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
          visibleLogs.map((entry) => (
            <Box key={`${entry.timestamp}-${entry.slaveId}-${entry.source}`}>
              {renderLogLine(entry, true)}
            </Box>
          ))
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
  masterState,
}: DetailPanelProps) {
  if (!task) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="gray">Select a task to view details</Text>
      </Box>
    )
  }

  if (showLogs) {
    return renderFullLogView(task, logs, maxHeight)
  }

  const summaryLines = buildSummaryLines(task, activeSlaves, masterState)
  const showLiveLogs = isActiveTask(task)

  if (!showLiveLogs) {
    const visible = [
      ...summaryLines,
      <Text key="view-hint" color="gray">
        Press 'l' to view full logs
      </Text>,
    ].slice(0, maxHeight)

    return (
      <Box flexDirection="column">
        {visible.map((line, index) => (
          <Box key={index}>{line}</Box>
        ))}
      </Box>
    )
  }

  const summaryHeight = Math.max(6, Math.min(summaryLines.length + 1, Math.floor(maxHeight * 0.45)))
  const logHeight = Math.max(4, maxHeight - summaryHeight - 1)
  const visibleSummary = summaryLines.slice(0, summaryHeight - 1)
  const showSlaveId = activeSlaves.length !== 1
  const visibleLiveLogs = prioritizeLiveLogs(liveLogs).slice(-(logHeight - 1))
  const liveTitle =
    activeSlaves.length === 0
      ? 'LIVE LOGS: waiting for active slave [live]'
      : activeSlaves.length === 1
        ? `LIVE LOGS: ${activeSlaves[0].id.slice(-7)} (${activeSlaves[0].type}) [live]`
        : `LIVE LOGS: ${activeSlaves.length} slaves [live]`

  return (
    <Box flexDirection="column">
      {visibleSummary.map((line, index) => (
        <Box key={index}>{line}</Box>
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
        visibleLiveLogs.map((entry) => (
          <Box key={`live-${entry.timestamp}-${entry.slaveId}-${entry.source}`}>
            {renderLogLine(entry, showSlaveId)}
          </Box>
        ))
      )}
      <Box>
        <Text color="gray">Press 'l' to view full task logs</Text>
      </Box>
    </Box>
  )
}
