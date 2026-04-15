import { render } from 'ink'
import type { Master } from '../master/scheduler'
import { KanbanBoard } from './components/KanbanBoard'

interface TUIOptions {
  emitter: Master | null
  master: Master | null
  heartbeatIntervalMs: number
  onQuit: () => void
}

export function startTUI({ emitter, master, heartbeatIntervalMs, onQuit }: TUIOptions) {
  const App = () => (
    <KanbanBoard
      emitter={emitter}
      master={master}
      heartbeatIntervalMs={heartbeatIntervalMs}
      onQuit={onQuit}
    />
  )

  const instance = render(<App />)

  return instance
}
