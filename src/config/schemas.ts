// Auto-generated
import { z } from 'zod'

export const modelTierConfigSchema = z.object({
  lite: z.string().default('glm-4.5-air'),
  pro: z.string().default('glm-4.7'),
  max: z.string().default('glm-5.1'),
})

export const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
})

export const masterRuntimeConfigSchema = z.object({
  runtimeMode: z.enum(['heartbeat_agent', 'session_agent', 'hybrid']).default('heartbeat_agent'),
})

export const configSchema = z.object({
  heartbeatInterval: z.number().default(30000),
  maxConcurrency: z.number().min(1).max(20).default(3),
  maxRetryAttempts: z.number().default(3),
  worktreesDir: z.string().default('.worktrees'),
  developBranch: z.string().default('develop'),
  models: modelTierConfigSchema.default({
    lite: 'glm-4.5-air',
    pro: 'glm-4.7',
    max: 'glm-5.1',
  }),
  provider: providerConfigSchema.default({}),
  master: masterRuntimeConfigSchema.default({
    runtimeMode: 'heartbeat_agent',
  }),
})

export type Config = z.infer<typeof configSchema>
