import { z } from 'zod'

export const agentModelConfigSchema = z.object({
  lite: z.string().default('glm-4.5-air'),
  inspector: z.string().default('glm-5.1'),
  worker: z.string().default('glm-4.7'),
  reviewer: z.string().default('glm-4.7'),
  manager: z.string().default('glm-4.7'),
})

export const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
})

export const managerRuntimeConfigSchema = z.object({
  runtimeMode: z.enum(['heartbeat_agent', 'session_agent', 'hybrid']).default('heartbeat_agent'),
})

export const configSchema = z.object({
  heartbeatInterval: z.number().default(30000),
  maxConcurrency: z.number().min(1).max(20).default(3),
  maxRetryAttempts: z.number().default(3),
  worktreesDir: z.string().default('.worktrees'),
  developBranch: z.string().default('develop'),
  models: agentModelConfigSchema.default({
    lite: 'glm-4.5-air',
    inspector: 'glm-5.1',
    worker: 'glm-4.7',
    reviewer: 'glm-4.7',
    manager: 'glm-4.7',
  }),
  provider: providerConfigSchema.default({}),
  manager: managerRuntimeConfigSchema.default({
    runtimeMode: 'heartbeat_agent',
  }),
})

export type Config = z.infer<typeof configSchema>
