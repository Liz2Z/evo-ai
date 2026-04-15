import { Box, Text } from 'ink'
import type { MasterStage } from '../../types'
import type { MasterActivityItem } from './statusBarModel'

interface StatusBarProps {
  mission?: string
  phase: string
  stage: MasterStage
  heartbeatDisplay: string
  pendingQuestions: number
  masterActivities: MasterActivityItem[]
}

const PHASE_COLORS: Record<string, string> = {
  initializing: 'gray',
  inspecting: 'magenta',
  reviewing: 'cyan',
  idle: 'gray',
  running: 'green',
  paused: 'yellow',
  stopped: 'red',
}

const STAGE_COLORS: Record<MasterStage, string> = {
  idle: 'gray',
  inspecting: 'magenta',
  working: 'yellow',
  reviewing: 'cyan',
  committing: 'green',
}

const ACTIVITY_COLORS: Record<MasterActivityItem['kind'], string> = {
  turn_started: 'yellow',
  turn_completed: 'green',
  turn_failed: 'red',
  turn_skipped: 'gray',
}

function normalizeActivities(
  masterActivities: MasterActivityItem[],
): Array<MasterActivityItem | null> {
  return [...masterActivities, null, null, null].slice(0, 3)
}

export function StatusBar({
  mission,
  phase,
  stage,
  heartbeatDisplay,
  pendingQuestions,
  masterActivities,
}: StatusBarProps) {
  const activityRows = normalizeActivities(masterActivities)

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text bold color="cyan">
          EVO-AI
        </Text>
        <Text> | </Text>
        <Text>Mission: </Text>
        <Text color={mission ? 'white' : 'gray'} wrap="truncate-end">
          {mission || 'unset'}
        </Text>
      </Box>
      <Box>
        <Text>Phase: </Text>
        <Text bold color={PHASE_COLORS[phase] || 'white'}>
          {phase}
        </Text>
        <Text> | </Text>
        <Text>Stage: </Text>
        <Text bold color={STAGE_COLORS[stage]}>
          {stage}
        </Text>
        <Text> | </Text>
        <Text>Questions: </Text>
        <Text bold color={pendingQuestions > 0 ? 'red' : 'gray'}>
          {pendingQuestions}
        </Text>
      </Box>
      <Box>
        <Text>Heartbeat: </Text>
        <Text color="green">{heartbeatDisplay}</Text>
      </Box>
      {activityRows.map((activity, index) => (
        <Box key={activity?.id || `placeholder-${index}`}>
          {activity ? (
            <Text color={ACTIVITY_COLORS[activity.kind]} wrap="truncate">
              {activity.line}
            </Text>
          ) : (
            <Text color="gray">waiting for master activity...</Text>
          )}
        </Box>
      ))}
    </Box>
  )
}
