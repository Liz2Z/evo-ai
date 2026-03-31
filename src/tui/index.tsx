import React from 'react';
import { render } from 'ink';
import type { EventEmitter } from 'events';
import { KanbanBoard } from './components/KanbanBoard';

interface TUIOptions {
  emitter: EventEmitter | null;
  maxConcurrency: number;
  onQuit: () => void;
}

export function startTUI({ emitter, maxConcurrency, onQuit }: TUIOptions) {
  const App = () => (
    <KanbanBoard
      emitter={emitter}
      maxConcurrency={maxConcurrency}
      onQuit={onQuit}
    />
  );

  const instance = render(<App />);

  return instance;
}
