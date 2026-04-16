import type { CompleteMissionResult } from '../runtime'

export interface CompleteMissionDeps {
  completeMission: () => Promise<CompleteMissionResult>
}

export async function completeMissionTool(
  _params: undefined,
  deps: CompleteMissionDeps,
): Promise<CompleteMissionResult> {
  return deps.completeMission()
}
