import { updateAgent } from '../utils/storage'
import { type AgentExecutionResult, AgentLauncher, type AgentOptions } from './launcher'

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    }
  }
  return {
    message: String(error),
  }
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.text()
  const parsed = JSON.parse(raw) as { options: AgentOptions }
  const options = parsed.options

  const launcher = new AgentLauncher({
    ...options,
    onLog: (event) => {
      options.onLog?.(event)
      emit({ type: 'log', event })
    },
  })

  const cancel = async () => {
    await launcher.cancel().catch(() => {})
    process.exit(143)
  }

  process.on('SIGTERM', () => {
    void cancel()
  })
  process.on('SIGINT', () => {
    void cancel()
  })

  const { agentId } = await launcher.start()
  await updateAgent(agentId, { pid: process.pid })
  emit({ type: 'started', agentId, pid: process.pid })

  const result = (await launcher.execute()) as AgentExecutionResult
  emit({ type: 'result', result })
}

void main().catch((error) => {
  const serialized = serializeError(error)
  emit({ type: 'error', ...serialized })
  process.exitCode = 1
})
