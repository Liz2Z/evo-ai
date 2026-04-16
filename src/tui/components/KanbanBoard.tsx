import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useCallback, useState } from 'react'
import type { Manager } from '../../manager/scheduler'
import { useLogStream } from '../hooks/useLogStream'
import { useMasterState } from '../hooks/useMasterState'
import { COMMAND_HELP_TEXT, parseMissionCommand } from './commandParser'
import { DetailPanel } from './DetailPanel'
import { getActiveTaskSlaves } from './detailPanelModel'
import { InputBar, useInputBar } from './InputBar'
import { StatusBar } from './StatusBar'
import { getStatusBarHeight } from './statusBarModel'
import { TaskList } from './TaskList'

interface KanbanBoardProps {
  emitter: Manager | null
  manager: Manager | null
  heartbeatIntervalMs: number
  onQuit: () => void
}

export function KanbanBoard({ emitter, manager, heartbeatIntervalMs, onQuit }: KanbanBoardProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [showLogs, setShowLogs] = useState(false)
  const { inputActive, inputValue, setInputValue, activate, cancel } = useInputBar()
  const [lastMessage, setLastMessage] = useState('')
  const [quitting, setQuitting] = useState(false)

  const {
    tasks,
    agents,
    masterState,
    selectedTaskId,
    phase,
    heartbeatDisplay,
    masterActivities,
    selectTask,
  } = useMasterState(emitter, heartbeatIntervalMs)

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null
  const activeTaskSlaves = getActiveTaskSlaves(selectedTaskId, agents)
  const activeSlaveIds = activeTaskSlaves.map((agent) => agent.id)
  const logEntries = useLogStream(emitter, selectedTaskId)
  const liveLogEntries = useLogStream(emitter, selectedTaskId, activeSlaveIds)

  const handleCommand = useCallback(
    async (text: string) => {
      cancel()

      if (!text) return

      try {
        if (text.startsWith('/answer ')) {
          const parts = text.slice(8).split(' ')
          const qid = parts[0]
          const answer = parts.slice(1).join(' ')
          if (manager && qid && answer) {
            const { answerQuestion } = await import('../../utils/storage')
            await answerQuestion(qid, answer)
            setLastMessage(`Answered question ${qid}`)
          } else {
            setLastMessage('Usage: /answer <questionId> <answer>')
          }
        } else if (text === '/pause') {
          if (manager) {
            manager.pause()
            setLastMessage('Manager paused')
          }
        } else if (text === '/resume') {
          if (manager) {
            manager.resume()
            setLastMessage('Manager resumed')
          }
        } else if (text.startsWith('/cancel ')) {
          const taskId = text.slice(8).trim()
          if (manager && taskId) {
            await manager.cancelTask(taskId)
            setLastMessage(`Cancelled task ${taskId}`)
          }
        } else if (text === '/mission' || text.startsWith('/mission ')) {
          const missionCommand = parseMissionCommand(text)
          if (!missionCommand) {
            setLastMessage('Usage: /mission [--force] <mission>')
          } else if (manager) {
            await manager.setMission(missionCommand.mission, missionCommand.force)
            setLastMessage(
              `Mission updated${missionCommand.force ? ' (forced)' : ''}: ${missionCommand.mission}`,
            )
          }
        } else if (text.startsWith('/task ')) {
          const description = text.slice(6).trim()
          if (manager && description) {
            const task = await manager.addTaskManually(description)
            setLastMessage(`Task created: ${task.id.slice(-7)} - ${task.description.slice(0, 50)}`)
          } else {
            setLastMessage('Usage: /task <description>')
          }
        } else if (text === '/help') {
          setLastMessage(COMMAND_HELP_TEXT)
        } else {
          if (manager) {
            await manager.sendMessageToManager(text)
            setLastMessage(`Sent to manager: ${text.slice(0, 60)}`)
          }
        }
      } catch (err) {
        setLastMessage(`Error: ${err}`)
      }
    },
    [manager, cancel],
  )

  const unansweredQuestions = (masterState?.pendingQuestions || []).filter(
    (question) => !question.answered,
  )
  const pendingQuestions = unansweredQuestions.length
  const primaryQuestion = unansweredQuestions[0]

  const handleQuit = useCallback(async () => {
    if (quitting) return
    setQuitting(true)
    try {
      await onQuit()
      exit()
    } catch (error) {
      setLastMessage(`Quit failed: ${error instanceof Error ? error.message : String(error)}`)
      setQuitting(false)
    }
  }, [exit, onQuit, quitting])

  // Global key handling (only when input is NOT active)
  useInput((input, key) => {
    if (inputActive) return

    if (input === 'q') {
      void handleQuit()
      return
    }
    if (input === 'l') {
      setShowLogs((prev) => !prev)
    }
    if (key.escape) {
      setShowLogs(false)
    }
    if (input === 'a' && primaryQuestion) {
      activate(`/answer ${primaryQuestion.id} `)
    }
  })

  // Calculate available height for main content
  const termRows = stdout?.rows || 24
  const fixedHeight = getStatusBarHeight() + (lastMessage ? 1 : 0) + 3
  const mainHeight = Math.max(8, termRows - fixedHeight)

  const questionPanelHeight = primaryQuestion ? 4 : 0
  const adjustedMainHeight = Math.max(8, mainHeight - questionPanelHeight)

  return (
    <Box flexDirection="column">
      {/* Status bar */}
      <StatusBar
        mission={masterState?.mission}
        phase={phase}
        stage={masterState?.currentStage || 'idle'}
        heartbeatDisplay={heartbeatDisplay}
        pendingQuestions={pendingQuestions}
        masterActivities={masterActivities}
      />

      {primaryQuestion && (
        <Box flexDirection="column" borderStyle="single" borderColor="red" paddingX={1}>
          {/* Row 1: metadata - which phase + shortcuts */}
          <Box>
            <Text bold color="red">
              PENDING{' '}
            </Text>
            {primaryQuestion.source && <Text color="gray">[{primaryQuestion.source}] </Text>}
            <Text color="gray" wrap="truncate">
              {`#${primaryQuestion.id.slice(-8)}`}
              {unansweredQuestions.length > 1 ? ` | +${unansweredQuestions.length - 1} more` : ''}
              {" | Press 'a' to answer"}
            </Text>
          </Box>
          {/* Row 2: question text + options, truncated to one line */}
          <Box>
            <Text wrap="truncate">
              {primaryQuestion.question}
              {primaryQuestion.options.length > 0
                ? ` [${primaryQuestion.options.join(' / ')}]`
                : ''}
            </Text>
          </Box>
        </Box>
      )}

      {/* Main content */}
      <Box flexDirection="row" height={adjustedMainHeight}>
        {/* Left panel - Task list */}
        <Box flexDirection="column" width={35} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="cyan">
            TASKS
          </Text>
          <Text color="gray">↑↓ 任务 ←→ 阶段</Text>
          <TaskList
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelect={selectTask}
            maxHeight={adjustedMainHeight - 3}
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
            activeAgents={activeTaskSlaves}
            logs={logEntries}
            liveLogs={liveLogEntries}
            showLogs={showLogs}
            maxHeight={adjustedMainHeight - 2}
            masterState={masterState}
          />
        </Box>
      </Box>

      {/* Last command result */}
      {lastMessage && (
        <Box paddingX={1}>
          <Text color="green">{lastMessage}</Text>
        </Box>
      )}

      {quitting && (
        <Box paddingX={1}>
          <Text color="yellow">Shutting down...</Text>
        </Box>
      )}

      {/* Input bar */}
      <InputBar
        active={inputActive}
        value={inputValue}
        onActivate={activate}
        onCancel={cancel}
        onSubmit={handleCommand}
        onChange={setInputValue}
      />
    </Box>
  )
}
