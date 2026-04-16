import type { Config } from '../types'

export type ModelPurpose = 'taskTitle' | 'inspector' | 'worker' | 'reviewer' | 'manager'

const MODEL_KEY_BY_PURPOSE: Record<ModelPurpose, keyof Config['models']> = {
  taskTitle: 'lite',
  inspector: 'inspector',
  worker: 'worker',
  reviewer: 'reviewer',
  manager: 'manager',
}

export function getModelKeyForPurpose(purpose: ModelPurpose): keyof Config['models'] {
  return MODEL_KEY_BY_PURPOSE[purpose]
}

export function getConfiguredModel(
  config: Pick<Config, 'models'>,
  purpose: ModelPurpose,
): string | undefined {
  const key = getModelKeyForPurpose(purpose)
  const model = config.models?.[key]?.trim()
  return model ? model : undefined
}
