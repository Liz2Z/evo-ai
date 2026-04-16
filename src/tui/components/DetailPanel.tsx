import { Box, Text } from 'ink'
import type React from 'react'
import { isValidElement } from 'react'
import type { AgentInfo, LogEntry, ManagerState, Task } from '../../types'
import { formatBeijingTime } from '../../utils/time'
import {
  calculateDetailPanelSections,
  getTaskFailureReason,
  isActiveTask,
} from './detailPanelModel'

interface DetailPanelProps {
  task: Task | null
  activeAgents: AgentInfo[]
  logs: LogEntry[]
  liveLogs: LogEntry[]
  showLogs: boolean
  maxHeight: number
  masterState?: ManagerState | null
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  running: 'yellow',
  reviewing: 'cyan',
  completed: 'green',
  failed: 'red',
}

function formatTime(iso: string): string {
  return iso ? formatBeijingTime(iso) : 'N/A'
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}

function renderLogLine(entry: LogEntry, showSlaveId: boolean) {
  return (
    <Box>
      <Text wrap="truncate-end">
        <Text color="gray">{formatTime(entry.timestamp)} </Text>
        {showSlaveId && <Text color="cyan">[{entry.agentId.slice(-7)}] </Text>}
        <Text color={entry.level === 'error' ? 'red' : entry.level === 'debug' ? 'gray' : 'white'}>
          {entry.message}
        </Text>
      </Text>
    </Box>
  )
}

function prioritizeLiveLogs(logs: LogEntry[]): LogEntry[] {
  const primary = logs.filter((entry) => entry.source !== 'status')
  const secondary = logs.filter((entry) => entry.source === 'status')
  return [...primary, ...secondary]
}

function getNodeKey(node: React.ReactNode, fallback: string): string {
  if (isValidElement(node) && node.key != null) {
    return String(node.key)
  }

  return fallback
}

function buildSummaryLines(
  task: Task,
  activeAgents: AgentInfo[],
  masterState?: ManagerState | null,
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
      <Text key="stage" wrap="truncate-end">
        Mission stage: <Text color="cyan">{masterState.currentStage}</Text>
      </Text>,
    )
  }
  if (masterState?.missionBranch) {
    lines.push(
      <Text key="branch" wrap="truncate-end">
        Mission branch: <Text color="cyan">{masterState.missionBranch}</Text>
      </Text>,
    )
  }
  if (masterState?.missionWorktree) {
    lines.push(
      <Text key="worktree" wrap="truncate-end">
        Mission worktree: <Text color="gray">{masterState.missionWorktree}</Text>
      </Text>,
    )
  }
  if (task.attemptCount > 0) {
    lines.push(
      <Text key="attempts" wrap="truncate-end">
        Review rounds: {task.attemptCount}/{task.maxAttempts}
      </Text>,
    )
  }

  lines.push(
    <Text key="desc-label" wrap="truncate-end">
      Description:
    </Text>,
  )
  lines.push(
    <Text key="desc-text" wrap="truncate-end">
      {truncateText(task.description, 500)}
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
      <Text key="failure-text" color="red" wrap="truncate-end">
        {truncateText(failureReason, 500)}
      </Text>,
    )
  }

  if (activeAgents.length > 0) {
    lines.push(
      <Text key="agents-label" wrap="truncate-end">
        Active agent{activeAgents.length > 1 ? 's' : ''}:
      </Text>,
    )
    activeAgents.forEach((agent, idx) => {
      lines.push(
        <Text key={`agent-${agent.id}-${idx}`} wrap="truncate-end">
          {agent.id} ({agent.type}) <Text color="yellow">{agent.status}</Text> since{' '}
          {formatTime(agent.startedAt || '')}
        </Text>,
      )
    })
  }

  if (task.reviewHistory.length > 0) {
    const last = task.reviewHistory[task.reviewHistory.length - 1]
    lines.push(
      <Text key="review-verdict" wrap="truncate-end">
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
    lines.push(
      <Text key="review-summary" wrap="truncate-end">
        {truncateText(last.review.summary, 500)}
      </Text>,
    )
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
            <Box key={`${entry.timestamp}-${entry.agentId}-${entry.source}`}>
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
  activeAgents,
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

  const summaryLines = buildSummaryLines(task, activeAgents, masterState)
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
          <Box key={getNodeKey(line, `detail-${index}`)}>{line}</Box>
        ))}
      </Box>
    )
  }

  const { summarySectionHeight, summaryBodyHeight, liveLogSectionHeight, liveLogBodyHeight } =
    calculateDetailPanelSections(maxHeight, summaryLines.length)
  const visibleSummary = summaryLines.slice(0, summaryBodyHeight)
  const showSlaveId = activeAgents.length !== 1
  const visibleLiveLogs = prioritizeLiveLogs(liveLogs).slice(-liveLogBodyHeight)
  const liveTitle =
    activeAgents.length === 0
      ? 'LIVE LOGS: waiting for active agent [live]'
      : activeAgents.length === 1
        ? `LIVE LOGS: ${activeAgents[0].id.slice(-7)} (${activeAgents[0].type}) [live]`
        : `LIVE LOGS: ${activeAgents.length} agents [live]`

  return (
    <Box flexDirection="column" height={maxHeight}>
      <Box flexDirection="column" height={summarySectionHeight} flexShrink={0}>
        <Box>
          <Text bold color="cyan">
            STATS
          </Text>
        </Box>
        {visibleSummary.map((line, index) => (
          <Box key={getNodeKey(line, `summary-${index}`)}>{line}</Box>
        ))}
      </Box>
      <Box flexDirection="column" height={liveLogSectionHeight}>
        <Box>
          <Text bold color="cyan">
            {liveTitle}
          </Text>
          <Text color="gray"> ({liveLogs.length} lines)</Text>
        </Box>
        {activeAgents.length === 0 ? (
          <Text color="gray">Task is active, but no busy agent is currently attached.</Text>
        ) : visibleLiveLogs.length === 0 ? (
          <Text color="gray">Waiting for agent logs...</Text>
        ) : (
          visibleLiveLogs.map((entry) => (
            <Box key={`live-${entry.timestamp}-${entry.agentId}-${entry.source}`}>
              {renderLogLine(entry, showSlaveId)}
            </Box>
          ))
        )}
      </Box>
    </Box>
  )
}
