import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

interface InputBarProps {
  active: boolean;
  value: string;
  placeholder: string;
  onActivate: () => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  onChange: (text: string) => void;
}

export function InputBar({ active, value, placeholder, onActivate, onCancel, onSubmit, onChange }: InputBarProps) {
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

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>{'> '}</Text>
      <Text>{value}</Text>
      <Text backgroundColor="cyan"> </Text>
    </Box>
  );
}

// Hook to manage input state
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
