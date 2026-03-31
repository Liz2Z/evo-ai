import React from 'react';
import { Box, Text } from 'ink';
import type { Task, SlaveInfo, LogEntry } from '../../types';

interface DetailPanelProps {
  task: Task | null;
  slaves: SlaveInfo[];
  logs: LogEntry[];
  showLogs: boolean;
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
};

function formatTime(iso: string): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

export function DetailPanel({ task, slaves, logs, showLogs }: DetailPanelProps) {
  if (!task) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="gray">Select a task to view details</Text>
      </Box>
    );
  }

  // Find slave working on this task
  const taskSlave = slaves.find(s => s.currentTask === task.id);

  if (showLogs) {
    return (
      <Box flexDirection="column" width="100%">
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>LOG: {task.id.slice(-7)}</Text>
          <Text color="gray"> ({logs.length} lines)</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={1}>
          {logs.length === 0 ? (
            <Text color="gray">No logs yet...</Text>
          ) : (
            logs.slice(-30).map((entry, i) => (
              <Box key={i}>
                <Text color="gray">{formatTime(entry.timestamp)} </Text>
                <Text color={entry.level === 'error' ? 'red' : entry.level === 'debug' ? 'gray' : 'white'}>
                  {entry.message}
                </Text>
              </Box>
            ))
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Box flexDirection="column">
          <Box>
            <Text bold>TASK: </Text>
            <Text bold color="cyan">{task.id.slice(-7)}</Text>
          </Box>
          <Box>
            <Text>Status: </Text>
            <Text bold color={STATUS_COLORS[task.status] || 'white'}>{task.status}</Text>
          </Box>
          <Box>
            <Text>Type: {task.type}  Priority: {task.priority}</Text>
          </Box>
          <Box>
            <Text>Created: {formatTime(task.createdAt)}</Text>
          </Box>
          <Box>
            <Text>Updated: {formatTime(task.updatedAt)}</Text>
          </Box>
          {task.branch && (
            <Box>
              <Text>Branch: </Text>
              <Text color="cyan">{task.branch}</Text>
            </Box>
          )}
          {task.worktree && (
            <Box>
              <Text>Worktree: </Text>
              <Text color="gray">{task.worktree}</Text>
            </Box>
          )}
          {task.attemptCount > 0 && (
            <Box>
              <Text>Attempts: {task.attemptCount}/{task.maxAttempts}</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Description */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <Box flexDirection="column">
          <Text bold>DESCRIPTION</Text>
          <Text>{task.description}</Text>
        </Box>
      </Box>

      {/* Slave info */}
      {taskSlave && (
        <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
          <Box flexDirection="column">
            <Text bold>SLAVE</Text>
            <Text>ID: {taskSlave.id}</Text>
            <Text>Type: {taskSlave.type}</Text>
            <Text>Status: </Text>
            <Text bold color="yellow">{taskSlave.status}</Text>
            <Text>Started: {formatTime(taskSlave.startedAt || '')}</Text>
          </Box>
        </Box>
      )}

      {/* Review history */}
      {task.reviewHistory.length > 0 && (
        <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
          <Box flexDirection="column">
            <Text bold>REVIEWS ({task.reviewHistory.length})</Text>
            {task.reviewHistory.map((rh, i) => (
              <Box key={i} flexDirection="column">
                <Text>
                  Attempt {rh.attempt}:{' '}
                  <Text color={rh.review.verdict === 'approve' ? 'green' : rh.review.verdict === 'reject' ? 'red' : 'yellow'}>
                    {rh.review.verdict}
                  </Text>
                  {' '}(confidence: {rh.review.confidence})
                </Text>
                <Text color="gray">  {rh.review.summary.slice(0, 80)}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* Context */}
      {task.context && (
        <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
          <Box flexDirection="column">
            <Text bold>CONTEXT</Text>
            <Text color="gray">{task.context.slice(0, 200)}{task.context.length > 200 ? '...' : ''}</Text>
          </Box>
        </Box>
      )}

      {/* Log preview */}
      <Box marginTop={1}>
        <Text color="gray">Press 'l' to view full logs</Text>
      </Box>
    </Box>
  );
}
