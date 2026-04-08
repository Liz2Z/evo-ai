import { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

interface InputBarProps {
  active: boolean;
  value: string;
  onActivate: () => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  onChange: (text: string) => void;
}

const COMMANDS = [
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/pause', desc: 'Pause master heartbeat' },
  { cmd: '/resume', desc: 'Resume master heartbeat' },
  { cmd: '/cancel', desc: 'Cancel a task by ID' },
  { cmd: '/answer', desc: 'Answer a pending question' },
  { cmd: '/mission', desc: 'Update master mission' },
];

function getMatchingCommands(input: string): typeof COMMANDS {
  if (!input.startsWith('/')) return [];
  const partial = input.toLowerCase();
  return COMMANDS.filter(c => c.cmd.startsWith(partial));
}

export function InputBar({ active, value, onActivate, onCancel, onSubmit, onChange }: InputBarProps) {
  useInput((input, key) => {
    if (!active) {
      if (input === ':') {
        onActivate();
      }
      return;
    }

    if (key.escape) {
      onChange('');
      onCancel();
      return;
    }

    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
      }
      onChange('');
      return;
    }

    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      onChange(value + input);
    }
  });

  if (!active) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray">Press ':' to enter command, or 'q' to quit</Text>
      </Box>
    );
  }

  const matches = getMatchingCommands(value);

  return (
    <Box flexDirection="column">
      {/* Input line */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text color="cyan" bold>{'> '}</Text>
        <Text>{value}</Text>
        <Text backgroundColor="cyan"> </Text>
        {matches.length === 1 && (
          <Text color="gray">
            {/* Autocomplete hint: show remaining text */}
            {matches[0].cmd.slice(value.length)} — {matches[0].desc}
          </Text>
        )}
      </Box>
      {/* Command suggestions */}
      {matches.length > 1 && (
        <Box paddingLeft={3} flexDirection="column">
          {matches.map(m => (
            <Box key={m.cmd}>
              <Text color="cyan">{m.cmd}</Text>
              <Text color="gray"> — {m.desc}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

export function useInputBar() {
  const [inputActive, setInputActive] = useState(false);
  const [inputValue, setInputValue] = useState('');

  const activate = useCallback(() => {
    setInputActive(true);
    setInputValue('');
  }, []);

  const cancel = useCallback(() => {
    setInputActive(false);
    setInputValue('');
  }, []);

  return {
    inputActive,
    inputValue,
    setInputValue,
    activate,
    cancel,
  };
}
