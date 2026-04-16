import { describe, expect, test } from 'bun:test'
import { getConfiguredModel, getModelKeyForPurpose } from '../../src/config'

describe('模型档位映射', () => {
  const config = {
    models: {
      lite: 'haiku',
      inspector: 'haiku-inspector',
      worker: 'sonnet',
      reviewer: 'sonnet-review',
      manager: 'opus',
    },
  }

  test('title 生成使用 lite', () => {
    expect(getModelKeyForPurpose('taskTitle')).toBe('lite')
    expect(getConfiguredModel(config, 'taskTitle')).toBe('haiku')
  })

  test('worker 执行使用 worker 模型', () => {
    expect(getModelKeyForPurpose('worker')).toBe('worker')
    expect(getConfiguredModel(config, 'worker')).toBe('sonnet')
  })

  test('manager 执行使用 manager 模型', () => {
    expect(getModelKeyForPurpose('manager')).toBe('manager')
    expect(getConfiguredModel(config, 'manager')).toBe('opus')
  })
})
