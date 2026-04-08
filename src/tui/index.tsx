import React from 'react';
import { render } from 'ink';
import type { Master } from '../master/scheduler';
import { KanbanBoard } from './components/KanbanBoard';

interface TUIOptions {
  emitter: Master | null;
  master: Master | null;
  maxConcurrency: number;
  onQuit: () => void;
}

export function startTUI({ emitter, master, maxConcurrency, onQuit }: TUIOptions) {
  const App = () => (
    <KanbanBoard
      emitter={emitter}
      master={master}
      maxConcurrency={maxConcurrency}
      onQuit={onQuit}
    />
  );

  const instance = render(<App />);

  return instance;
}
