import { getModel, getModels, getProviders, type Model } from '@mariozechner/pi-ai'
import { createAgentSession, SessionManager } from '@mariozechner/pi-coding-agent'
import type { Config } from '../types'

const PROVIDER_ENV_KEY_MAP: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
}

function setProviderApiKeyEnv(provider: string, apiKey?: string): void {
  if (!apiKey) return
  const keys = PROVIDER_ENV_KEY_MAP[provider] || []
  for (const key of keys) {
    process.env[key] = apiKey
  }
}

function findModelAcrossProviders(modelId: string): Model<any> | null {
  for (const provider of getProviders()) {
    const model = getModels(provider).find((item) => item.id === modelId)
    if (model) {
      return model
    }
  }
  return null
}

function inferProviderFromBaseUrl(baseUrl?: string): string | null {
  if (!baseUrl) return null
  const normalized = baseUrl.toLowerCase()
  if (normalized.includes('/anthropic')) return 'anthropic'
  if (normalized.includes('openrouter')) return 'openrouter'
  if (normalized.includes('openai')) return 'openai'
  if (
    normalized.includes('zhipu') ||
    normalized.includes('bigmodel') ||
    normalized.includes('/zai')
  ) {
    return 'zai'
  }
  return null
}

function buildCustomProviderModel(
  provider: string,
  modelId: string,
  baseUrl: string,
): Model<any> | null {
  const providerModels = getModels(provider as any)
  const template = providerModels[0]
  if (!template) return null
  return {
    ...template,
    id: modelId,
    name: modelId,
    provider,
    baseUrl,
  }
}

export function resolvePiModel(modelId: string, baseUrl?: string): Model<any> {
  const normalized = modelId.trim()
  const inferredProvider = inferProviderFromBaseUrl(baseUrl)
  if (inferredProvider && baseUrl) {
    const customModel = buildCustomProviderModel(inferredProvider, normalized, baseUrl)
    if (customModel) return customModel
  }

  let model: Model<any> | null = null

  if (normalized.includes(':')) {
    const [provider, providerModelId] = normalized.split(':', 2)
    if (provider && providerModelId) {
      try {
        model = getModel(provider as any, providerModelId as any)
      } catch {
        model = null
      }
    }
  }

  if (!model) {
    try {
      model = getModel('zai', normalized as any)
    } catch {
      model = null
    }
  }

  if (!model) {
    model = findModelAcrossProviders(normalized)
  }

  if (!model) {
    throw new Error(`Unsupported model id for pi-coding-agent: ${normalized}`)
  }

  return baseUrl ? { ...model, baseUrl } : model
}

export interface CreatePiSessionOptions {
  cwd: string
  config: Config
  modelId: string
  tools?: any[]
  customTools?: any[]
}

export interface PiSessionLifecycle {
  abort?: () => Promise<void> | void
  dispose?: () => void
}

export async function createPiSession(options: CreatePiSessionOptions) {
  const model = resolvePiModel(options.modelId, options.config.provider.baseUrl)
  setProviderApiKeyEnv(model.provider, options.config.provider.apiKey)

  const result = await createAgentSession({
    cwd: options.cwd,
    model,
    tools: options.tools,
    customTools: options.customTools,
    sessionManager: SessionManager.inMemory(),
  })

  return {
    session: result.session,
    model,
  }
}

export async function abortPiSession(session?: PiSessionLifecycle | null): Promise<void> {
  if (!session?.abort) return
  try {
    await session.abort()
  } catch {
    // Best effort cleanup.
  }
}

export function disposePiSession(session?: PiSessionLifecycle | null): void {
  if (!session?.dispose) return
  try {
    session.dispose()
  } catch {
    // Best effort cleanup.
  }
}
