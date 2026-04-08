import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { LogEntry } from '../../src/types';
import { getGlobalLogBuffer } from '../../src/utils/logger';
import {
  loadTaskLogs,
  mergeLogEntries,
  parseLogFileContent,
} from '../../src/tui/hooks/logStreamModel';

function logEntry(overrides: Partial<LogEntry>): LogEntry {
  return {
    timestamp: '2026-04-08T10:00:00.000Z',
    slaveId: 'worker-1',
    taskId: 'task-1',
    level: 'info',
    message: 'hello',
    ...overrides,
  };
}

afterEach(async () => {
  getGlobalLogBuffer().clear();
  await rm(join(process.cwd(), 'tmp-test-logs'), { recursive: true, force: true });
});

describe('logStreamModel', () => {
  test('同一任务多个 slave 日志时，仅返回目标 slave 的日志', () => {
    const merged = mergeLogEntries([
      [
        logEntry({ slaveId: 'worker-1', message: 'worker log' }),
        logEntry({ slaveId: 'reviewer-1', message: 'reviewer log', timestamp: '2026-04-08T10:00:01.000Z' }),
      ],
    ], ['worker-1']);

    expect(merged.map(entry => entry.message)).toEqual(['worker log']);
  });

  test('从持久化日志文件回补并按时间顺序返回', async () => {
    const logsDir = join(process.cwd(), 'tmp-test-logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, 'task-1.log'),
      [
        JSON.stringify(logEntry({ timestamp: '2026-04-08T10:00:02.000Z', message: 'second' })),
        JSON.stringify(logEntry({ timestamp: '2026-04-08T10:00:01.000Z', message: 'first' })),
      ].join('\n'),
    );

    const logs = await loadTaskLogs('task-1', ['worker-1'], { logsDir });

    expect(logs.map(entry => entry.message)).toEqual(['first', 'second']);
  });

  test('内存与文件日志会去重合并', async () => {
    const logsDir = join(process.cwd(), 'tmp-test-logs');
    await mkdir(logsDir, { recursive: true });
    const duplicate = logEntry({ message: 'same line' });

    getGlobalLogBuffer().set('task-1', [duplicate]);
    await writeFile(join(logsDir, 'task-1.log'), `${JSON.stringify(duplicate)}\n`);

    const logs = await loadTaskLogs('task-1', ['worker-1'], { logsDir });

    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('same line');
  });

  test('日志文件解析会忽略非法行', () => {
    const parsed = parseLogFileContent([
      JSON.stringify(logEntry({ message: 'valid' })),
      'not-json',
      '',
    ].join('\n'));

    expect(parsed.map(entry => entry.message)).toEqual(['valid']);
  });
});
