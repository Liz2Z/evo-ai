import React from 'react';
import { render } from 'ink';
import type { EventEmitter } from 'events';
import type { Master } from '../master/scheduler';
import { KanbanBoard } from './components/KanbanBoard';

interface TUIOptions {
  emitter: EventEmitter | null;
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
