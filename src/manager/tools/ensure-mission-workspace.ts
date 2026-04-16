import type { MissionWorkspaceResult } from '../runtime'

export interface EnsureMissionWorkspaceDeps {
  ensureMissionWorkspaceReady: () => Promise<MissionWorkspaceResult>
}

export async function ensureMissionWorkspace({
  ensureMissionWorkspaceReady,
}: EnsureMissionWorkspaceDeps): Promise<ReturnType<typeof ensureMissionWorkspaceReady>> {
  return ensureMissionWorkspaceReady()
}
