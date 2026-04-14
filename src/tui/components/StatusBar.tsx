import { Box, Text } from 'ink'
import React from 'react'

interface StatusBarProps {
  phase: string
  lastHeartbeat: string
  activeSlaves: number
  maxConcurrency: number
  pendingQuestions: number
}

function timeAgo(iso: string): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 1000) return 'just now'
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  return `${Math.floor(diff / 60000)}m ago`
}

const PHASE_COLORS: Record<string, string> = {
  initializing: 'gray',
  inspecting: 'magenta',
  dispatching: 'yellow',
  reviewing: 'cyan',
  merging: 'green',
  idle: 'gray',
}

export function StatusBar({
  phase,
  lastHeartbeat,
  activeSlaves,
  maxConcurrency,
  pendingQuestions,
}: StatusBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">
        EVO-AI
      </Text>
      <Text> | </Text>
      <Text>Phase: </Text>
      <Text bold color={PHASE_COLORS[phase] || 'white'}>
        {phase}
      </Text>
      <Text> | </Text>
      <Text>Heartbeat: </Text>
      <Text color="green">{timeAgo(lastHeartbeat)}</Text>
      <Text> | </Text>
      <Text>Slaves: </Text>
      <Text bold color={activeSlaves > 0 ? 'yellow' : 'gray'}>
        {activeSlaves}/{maxConcurrency}
      </Text>
      <Text> | </Text>
      <Text>Questions: </Text>
      <Text bold color={pendingQuestions > 0 ? 'red' : 'gray'}>
        {pendingQuestions}
      </Text>
    </Box>
  )
}
