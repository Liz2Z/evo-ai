import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { EventEmitter } from 'events';
import { useMasterState } from '../hooks/useMasterState';
import { useLogStream } from '../hooks/useLogStream';
import { StatusBar } from './StatusBar';
import { WorktreeList } from './WorktreeList';
import { DetailPanel } from './DetailPanel';

interface KanbanBoardProps {
  emitter: EventEmitter | null;
  maxConcurrency: number;
  onQuit: () => void;
}

export function KanbanBoard({ emitter, maxConcurrency, onQuit }: KanbanBoardProps) {
  const { exit } = useApp();
  const [showLogs, setShowLogs] = useState(false);

  const {
    tasks,
    slaves,
    masterState,
    selectedTaskId,
    lastHeartbeat,
    phase,
    activeSlaves,
    selectTask,
  } = useMasterState(emitter);

  const logEntries = useLogStream(emitter, selectedTaskId);
  const selectedTask = tasks.find(t => t.id === selectedTaskId) || null;

  useInput((input, key) => {
    if (input === 'q') {
      onQuit();
      exit();
    }
    if (input === 'l') {
      setShowLogs(prev => !prev);
    }
    if (key.escape) {
      setShowLogs(false);
    }
  });

  const pendingQuestions = masterState?.pendingQuestions?.length || 0;

  return (
    <Box flexDirection="column" height="100%">
      {/* Status bar */}
      <StatusBar
        phase={phase}
        lastHeartbeat={lastHeartbeat}
        activeSlaves={activeSlaves}
        maxConcurrency={maxConcurrency}
        pendingQuestions={pendingQuestions}
      />

      {/* Main content */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Left panel - Worktree list */}
        <Box
          flexDirection="column"
          width={35}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <Text bold color="cyan">WORKTREES</Text>
          <WorktreeList
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelect={selectTask}
          />
        </Box>

        {/* Right panel - Detail */}
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <DetailPanel
            task={selectedTask}
            slaves={slaves}
            logs={logEntries}
            showLogs={showLogs}
          />
        </Box>
      </Box>

      {/* Bottom help bar */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray">
          ↑/↓ Navigate | Enter Select | l Logs | Esc Back | q Quit
        </Text>
      </Box>
    </Box>
  );
}
