import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Task, TaskStatus } from '../../types';

interface WorktreeListProps {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelect: (taskId: string | null) => void;
}

const STATUS_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  running: { icon: '●', color: 'yellow', label: 'RUNNING' },
  assigned: { icon: '●', color: 'yellow', label: 'RUNNING' },
  pending: { icon: '○', color: 'gray', label: 'PENDING' },
  reviewing: { icon: '◆', color: 'cyan', label: 'REVIEWING' },
  approved: { icon: '✓', color: 'green', label: 'APPROVED' },
  completed: { icon: '✓', color: 'green', label: 'COMPLETED' },
  failed: { icon: '✗', color: 'red', label: 'FAILED' },
  rejected: { icon: '✗', color: 'red', label: 'REJECTED' },
};

const GROUP_ORDER: TaskStatus[] = ['running', 'assigned', 'reviewing', 'pending', 'approved', 'completed', 'failed', 'rejected'];

function getGroupKey(status: TaskStatus): string {
  if (status === 'assigned') return 'running';
  return status;
}

export function WorktreeList({ tasks, selectedTaskId, onSelect }: WorktreeListProps) {
  // Build flat list of task IDs for navigation
  const flatIds = tasks.map(t => t.id);
  const currentIndex = selectedTaskId ? flatIds.indexOf(selectedTaskId) : -1;

  useInput((input, key) => {
    if (key.upArrow) {
      const next = currentIndex > 0 ? currentIndex - 1 : 0;
      onSelect(flatIds[next]);
    } else if (key.downArrow) {
      const next = currentIndex < flatIds.length - 1 ? currentIndex + 1 : flatIds.length - 1;
      onSelect(flatIds[next]);
    }
  });

  // Group tasks by status
  const grouped = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = getGroupKey(task.status);
    const group = grouped.get(key) || [];
    group.push(task);
    grouped.set(key, group);
  }

  // Render in group order
  let itemIndex = 0;

  return (
    <Box flexDirection="column" width="100%">
      {GROUP_ORDER.map(status => {
        const group = grouped.get(status);
        if (!group || group.length === 0) return null;
        const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;

        return (
          <Box key={status} flexDirection="column">
            <Box marginTop={itemIndex > 0 ? 1 : 0}>
              <Text bold color={cfg.color}>
                {cfg.label} ({group.length})
              </Text>
            </Box>
            {group.map(task => {
              const isSelected = task.id === selectedTaskId;
              const cfg2 = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
              itemIndex++;

              return (
                <Box key={task.id}>
                  <Text>
                    {isSelected ? '> ' : '  '}
                    <Text color={cfg2.color}>{cfg2.icon}</Text>
                    {' '}
                    <Text color={isSelected ? 'white' : 'gray'}>
                      {task.id.slice(-7)}
                    </Text>
                    {' '}
                    <Text color={isSelected ? 'white' : 'gray'}>
                      {task.description.slice(0, 30)}
                      {task.description.length > 30 ? '...' : ''}
                    </Text>
                  </Text>
                </Box>
              );
            })}
          </Box>
        );
      })}
      {tasks.length === 0 && (
        <Text color="gray">No tasks yet. Waiting for inspection...</Text>
      )}
    </Box>
  );
}
