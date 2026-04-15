import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useCallback, useState } from 'react'
import type { Master } from '../../master/scheduler'
import { useLogStream } from '../hooks/useLogStream'
import { useMasterState } from '../hooks/useMasterState'
import { DetailPanel } from './DetailPanel'
import { getActiveTaskSlaves } from './detailPanelModel'
import { InputBar, useInputBar } from './InputBar'
import { StatusBar } from './StatusBar'
import { getStatusBarHeight } from './statusBarModel'
import { TaskList } from './TaskList'

interface KanbanBoardProps {
  emitter: Master | null
  master: Master | null
  heartbeatIntervalMs: number
  onQuit: () => void
}

export function KanbanBoard({ emitter, master, heartbeatIntervalMs, onQuit }: KanbanBoardProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [showLogs, setShowLogs] = useState(false)
  const { inputActive, inputValue, setInputValue, activate, cancel } = useInputBar()
  const [lastMessage, setLastMessage] = useState('')
  const [quitting, setQuitting] = useState(false)

  const {
    tasks,
    slaves,
    masterState,
    selectedTaskId,
    phase,
    heartbeatDisplay,
    masterActivities,
    selectTask,
  } = useMasterState(emitter, heartbeatIntervalMs)

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null
  const activeTaskSlaves = getActiveTaskSlaves(selectedTaskId, slaves)
  const activeSlaveIds = activeTaskSlaves.map((slave) => slave.id)
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
          if (master && qid && answer) {
            const { answerQuestion } = await import('../../utils/storage')
            await answerQuestion(qid, answer)
            setLastMessage(`Answered question ${qid}`)
          } else {
            setLastMessage('Usage: /answer <questionId> <answer>')
          }
        } else if (text === '/pause') {
          if (master) {
            master.pause()
            setLastMessage('Master paused')
          }
        } else if (text === '/resume') {
          if (master) {
            master.resume()
            setLastMessage('Master resumed')
          }
        } else if (text.startsWith('/cancel ')) {
          const taskId = text.slice(8).trim()
          if (master && taskId) {
            await master.cancelTask(taskId)
            setLastMessage(`Cancelled task ${taskId}`)
          }
        } else if (text.startsWith('/mission ')) {
          const mission = text.slice(9).trim()
          if (master) {
            await master.setMission(mission)
            setLastMessage(`Mission updated: ${mission}`)
          }
        } else if (text === '/help') {
          setLastMessage(
            'Commands: /answer /pause /resume /cancel /mission /help | Plain text = new task',
          )
        } else {
          if (master) {
            const task = await master.addTaskManually(text)
            setLastMessage(`Task created: ${task.id.slice(-7)} - ${task.description.slice(0, 50)}`)
          }
        }
      } catch (err) {
        setLastMessage(`Error: ${err}`)
      }
    },
    [master, cancel],
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
            activeSlaves={activeTaskSlaves}
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
