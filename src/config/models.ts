import type { Config, ModelTier } from "../types";

export type ModelPurpose = "taskTitle" | "slave" | "master";

const MODEL_TIER_BY_PURPOSE: Record<ModelPurpose, ModelTier> = {
  taskTitle: "lite",
  slave: "pro",
  master: "max",
};

export function getModelTierForPurpose(purpose: ModelPurpose): ModelTier {
  return MODEL_TIER_BY_PURPOSE[purpose];
}

export function getConfiguredModel(
  config: Pick<Config, "models">,
  purpose: ModelPurpose,
): string | undefined {
  const tier = getModelTierForPurpose(purpose);
  const model = config.models?.[tier]?.trim();
  return model ? model : undefined;
}
