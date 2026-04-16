import { updateSlave } from '../utils/storage'
import { type SlaveExecutionResult, SlaveLauncher, type SlaveOptions } from './launcher'

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
  const parsed = JSON.parse(raw) as { options: SlaveOptions }
  const options = parsed.options

  const launcher = new SlaveLauncher({
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

  const { slaveId } = await launcher.start()
  await updateSlave(slaveId, { pid: process.pid })
  emit({ type: 'started', slaveId, pid: process.pid })

  const result = (await launcher.execute()) as SlaveExecutionResult
  emit({ type: 'result', result })
}

void main().catch((error) => {
  const serialized = serializeError(error)
  emit({ type: 'error', ...serialized })
  process.exitCode = 1
})
