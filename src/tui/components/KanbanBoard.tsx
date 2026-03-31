import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { EventEmitter } from 'events';
import type { Master } from '../../master/scheduler';
import { useMasterState } from '../hooks/useMasterState';
import { useLogStream } from '../hooks/useLogStream';
import { StatusBar } from './StatusBar';
import { WorktreeList } from './WorktreeList';
import { DetailPanel } from './DetailPanel';
import { InputBar, useInputBar } from './InputBar';

interface KanbanBoardProps {
  emitter: EventEmitter | null;
  master: Master | null;
  maxConcurrency: number;
  onQuit: () => void;
}

export function KanbanBoard({ emitter, master, maxConcurrency, onQuit }: KanbanBoardProps) {
  const { exit } = useApp();
  const [showLogs, setShowLogs] = useState(false);
  const { inputActive, inputValue, setInputValue, activate, cancel } = useInputBar();
  const [lastMessage, setLastMessage] = useState('');

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

  const handleCommand = useCallback(async (text: string) => {
    cancel();

    if (!text) return;

    try {
      if (text.startsWith('/answer ')) {
        // /answer <questionId> <answer text>
        const parts = text.slice(8).split(' ');
        const qid = parts[0];
        const answer = parts.slice(1).join(' ');
        if (master && qid && answer) {
          // Use Master's answerQuestion or storage directly
          const { answerQuestion } = await import('../../utils/storage');
          await answerQuestion(qid, answer);
          setLastMessage(`Answered question ${qid}`);
        } else {
          setLastMessage('Usage: /answer <questionId> <answer>');
        }
      } else if (text === '/pause') {
        if (master) {
          master.pause();
          setLastMessage('Master paused');
        }
      } else if (text === '/resume') {
        if (master) {
          master.resume();
          setLastMessage('Master resumed');
        }
      } else if (text.startsWith('/cancel ')) {
        const taskId = text.slice(8).trim();
        if (master && taskId) {
          await master.cancelTask(taskId);
          setLastMessage(`Cancelled task ${taskId}`);
        }
      } else if (text.startsWith('/mission ')) {
        // Update mission
        const mission = text.slice(9).trim();
        if (master) {
          const state = master.getState();
          state.mission = mission;
          setLastMessage(`Mission updated: ${mission}`);
        }
      } else if (text === '/help') {
        setLastMessage('Commands: /answer <id> <text> /pause /resume /cancel <id> /mission <text> /help | Plain text = new task');
      } else {
        // Plain text = add new task
        if (master) {
          const task = await master.addTaskManually(text);
          setLastMessage(`Task created: ${task.id.slice(-7)} - ${task.description.slice(0, 50)}`);
        }
      }
    } catch (err) {
      setLastMessage(`Error: ${err}`);
    }
  }, [master, cancel]);

  // Global key handling (only when input is NOT active)
  useInput((input, key) => {
    if (inputActive) return; // InputBar handles its own input

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

      {/* Last command result */}
      {lastMessage && (
        <Box paddingX={1}>
          <Text color="green">{lastMessage}</Text>
        </Box>
      )}

      {/* Input bar */}
      <InputBar
        active={inputActive}
        value={inputValue}
        placeholder="Enter command or task description..."
        onActivate={activate}
        onCancel={cancel}
        onSubmit={handleCommand}
        onChange={setInputValue}
      />
    </Box>
  );
}
