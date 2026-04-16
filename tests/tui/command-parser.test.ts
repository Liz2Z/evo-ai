import { describe, expect, test } from 'bun:test'
import { parseMissionCommand } from '../../src/tui/components/commandParser'

describe('parseMissionCommand', () => {
  test('普通 mission 命令应正确解析 mission 文本', () => {
    expect(parseMissionCommand('/mission runtime switch')).toEqual({
      mission: 'runtime switch',
      force: false,
    })
  })

  test('前置 --force 应正确解析', () => {
    expect(parseMissionCommand('/mission --force runtime switch')).toEqual({
      mission: 'runtime switch',
      force: true,
    })
  })

  test('后置 --force 应正确解析', () => {
    expect(parseMissionCommand('/mission runtime switch --force')).toEqual({
      mission: 'runtime switch',
      force: true,
    })
  })

  test('缺少 mission 内容时返回 null', () => {
    expect(parseMissionCommand('/mission')).toBeNull()
    expect(parseMissionCommand('/mission --force')).toBeNull()
  })
})
