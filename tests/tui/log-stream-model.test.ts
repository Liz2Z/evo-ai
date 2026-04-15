import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getRuntimeDataDir } from '../../src/runtime/paths'
import {
  loadTaskLogs,
  mergeLogEntries,
  parseLogFileContent,
} from '../../src/tui/hooks/logStreamModel'
import type { LogEntry } from '../../src/types'
import { getGlobalLogBuffer } from '../../src/utils/logger'

function logEntry(overrides: Partial<LogEntry>): LogEntry {
  return {
    timestamp: '2026-04-08T10:00:00.000Z',
    slaveId: 'worker-1',
    taskId: 'task-1',
    source: 'status',
    level: 'info',
    message: 'hello',
    ...overrides,
  }
}

afterEach(async () => {
  getGlobalLogBuffer().clear()
  await rm(join(process.cwd(), 'tmp-test-logs'), { recursive: true, force: true })
})

describe('logStreamModel', () => {
  test('同一任务多个 slave 日志时，仅返回目标 slave 的日志', () => {
    const merged = mergeLogEntries(
      [
        [
          logEntry({ slaveId: 'worker-1', message: 'worker log' }),
          logEntry({
            slaveId: 'reviewer-1',
            message: 'reviewer log',
            timestamp: '2026-04-08T10:00:01.000Z',
          }),
        ],
      ],
      ['worker-1'],
    )

    expect(merged.map((entry) => entry.message)).toEqual(['worker log'])
  })

  test('从持久化日志文件回补并按时间顺序返回', async () => {
    const logsDir = join(process.cwd(), 'tmp-test-logs')
    await mkdir(logsDir, { recursive: true })
    await writeFile(
      join(logsDir, 'task-1.log'),
      [
        JSON.stringify(logEntry({ timestamp: '2026-04-08T10:00:02.000Z', message: 'second' })),
        JSON.stringify(logEntry({ timestamp: '2026-04-08T10:00:01.000Z', message: 'first' })),
      ].join('\n'),
    )

    const logs = await loadTaskLogs('task-1', ['worker-1'], { logsDir })

    expect(logs.map((entry) => entry.message)).toEqual(['first', 'second'])
  })

  test('内存与文件日志会去重合并', async () => {
    const logsDir = join(process.cwd(), 'tmp-test-logs')
    await mkdir(logsDir, { recursive: true })
    const duplicate = logEntry({ message: 'same line' })

    getGlobalLogBuffer().set('task-1', [duplicate])
    await writeFile(join(logsDir, 'task-1.log'), `${JSON.stringify(duplicate)}\n`)

    const logs = await loadTaskLogs('task-1', ['worker-1'], { logsDir })

    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe('same line')
  })

  test('同一条消息但不同 source 不会被误去重', () => {
    const merged = mergeLogEntries([
      [
        logEntry({ source: 'status', message: 'same' }),
        logEntry({ source: 'tool_step', message: 'same' }),
      ],
    ])

    expect(merged).toHaveLength(2)
    expect(merged.map((entry) => entry.source)).toEqual(['status', 'tool_step'])
  })

  test('日志文件解析会忽略非法行', () => {
    const parsed = parseLogFileContent(
      [JSON.stringify(logEntry({ message: 'valid' })), 'not-json', ''].join('\n'),
    )

    expect(parsed.map((entry) => entry.message)).toEqual(['valid'])
  })

  test('默认从 runtime logs 路径读取持久化日志', async () => {
    const originalCwd = process.cwd()
    const sandboxDir = join(process.cwd(), 'tmp-test-runtime-logs')

    await mkdir(sandboxDir, { recursive: true })
    process.chdir(sandboxDir)
    try {
      const logsDir = join(getRuntimeDataDir(), 'logs')
      await mkdir(logsDir, { recursive: true })
      await writeFile(
        join(logsDir, 'task-1.log'),
        `${JSON.stringify(logEntry({ message: 'runtime' }))}\n`,
      )

      const logs = await loadTaskLogs('task-1', ['worker-1'])
      expect(logs.map((entry) => entry.message)).toEqual(['runtime'])
    } finally {
      process.chdir(originalCwd)
      await rm(sandboxDir, { recursive: true, force: true })
    }
  })
})
