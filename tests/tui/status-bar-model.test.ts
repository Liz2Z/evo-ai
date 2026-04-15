import { describe, expect, test } from 'bun:test'
import {
  formatHeartbeatDisplay,
  mergeMasterActivities,
} from '../../src/tui/components/statusBarModel'

describe('statusBarModel', () => {
  test('lastHeartbeat + interval 能正确算出 remaining/total', () => {
    const now = Date.parse('2026-04-15T10:00:10.000Z')
    const lastHeartbeat = new Date(now - 5_000).toISOString()

    const result = formatHeartbeatDisplay({
      phase: 'idle',
      lastHeartbeat,
      heartbeatIntervalMs: 30_000,
      now,
    })

    expect(result.remainingMs).toBe(25_000)
    expect(result.display).toBe('25s/30s')
  })

  test('paused / no heartbeat / remaining<0 的显示正确', () => {
    const paused = formatHeartbeatDisplay({
      phase: 'paused',
      lastHeartbeat: '2026-04-15T10:00:00.000Z',
      heartbeatIntervalMs: 30_000,
      now: Date.parse('2026-04-15T10:00:10.000Z'),
    })
    expect(paused.display).toBe('paused/30s')

    const noHeartbeat = formatHeartbeatDisplay({
      phase: 'idle',
      lastHeartbeat: '',
      heartbeatIntervalMs: 30_000,
      now: Date.parse('2026-04-15T10:00:10.000Z'),
    })
    expect(noHeartbeat.display).toBe('--/30s')

    const elapsed = formatHeartbeatDisplay({
      phase: 'running',
      lastHeartbeat: '2026-04-15T10:00:00.000Z',
      heartbeatIntervalMs: 30_000,
      now: Date.parse('2026-04-15T10:00:31.000Z'),
    })
    expect(elapsed.remainingMs).toBe(0)
    expect(elapsed.display).toBe('0s/30s')
  })

  test('master activity 只保留最近 3 条，重复事件不会重复入队', () => {
    let activities = mergeMasterActivities([], {
      timestamp: '2026-04-15T10:00:00.000Z',
      triggerReason: 'startup',
      summary: 'trigger=startup',
      toolCalls: [],
      kind: 'turn_started',
    })

    activities = mergeMasterActivities(activities, {
      timestamp: '2026-04-15T10:00:01.000Z',
      triggerReason: 'startup',
      summary: 'Worker assigned to task-1',
      toolCalls: ['get_master_snapshot', 'assign_worker'],
      kind: 'turn_completed',
    })

    activities = mergeMasterActivities(activities, {
      timestamp: '2026-04-15T10:00:02.000Z',
      triggerReason: 'heartbeat',
      summary: 'turn busy',
      toolCalls: [],
      kind: 'turn_skipped',
    })

    activities = mergeMasterActivities(activities, {
      timestamp: '2026-04-15T10:00:03.000Z',
      triggerReason: 'worker_completed:task-1',
      summary: 'boom',
      toolCalls: [],
      kind: 'turn_failed',
    })

    activities = mergeMasterActivities(activities, {
      timestamp: '2026-04-15T10:00:03.000Z',
      triggerReason: 'worker_completed:task-1',
      summary: 'boom',
      toolCalls: [],
      kind: 'turn_failed',
    })

    expect(activities).toHaveLength(3)
    expect(activities.map((item) => item.line)).toEqual([
      'failed: boom',
      'skipped: heartbeat (turn busy)',
      'Worker assigned to task-1',
    ])
  })

  test('multiline markdown summary 会被压成单行，避免撑爆顶部', () => {
    const activities = mergeMasterActivities([], {
      timestamp: '2026-04-15T10:00:01.000Z',
      triggerReason: 'heartbeat',
      summary:
        '**当前状态：**\n- 🔧 **进行中**: 调研 TUI 代码结构\n\n等待 worker 完成后再进行 review。',
      toolCalls: ['assign_worker'],
      kind: 'turn_completed',
    })

    expect(activities[0]?.line).toBe(
      '当前状态： 🔧 进行中 : 调研 TUI 代码结构 等待 worker 完成后再进行 review。',
    )
  })
})
