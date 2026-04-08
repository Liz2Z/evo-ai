// Auto-generated
import { describe, expect, test } from 'bun:test';
import { getConfiguredModel, getModelTierForPurpose } from '../../src/slave/launcher';

describe('模型档位映射', () => {
  const config = {
    models: {
      lite: 'haiku',
      pro: 'sonnet',
      max: 'opus',
    },
  };

  test('title 生成使用 lite', () => {
    expect(getModelTierForPurpose('taskTitle')).toBe('lite');
    expect(getConfiguredModel(config, 'taskTitle')).toBe('haiku');
  });

  test('slave 执行使用 pro', () => {
    expect(getModelTierForPurpose('slave')).toBe('pro');
    expect(getConfiguredModel(config, 'slave')).toBe('sonnet');
  });

  test('master 执行使用 max', () => {
    expect(getModelTierForPurpose('master')).toBe('max');
    expect(getConfiguredModel(config, 'master')).toBe('opus');
  });
});
