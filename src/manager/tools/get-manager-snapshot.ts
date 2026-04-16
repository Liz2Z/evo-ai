import type { ManagerState } from '../../types'
import { loadTasks } from '../../utils/storage'
import type { ManagerTools } from '../runtime'

export async function getManagerSnapshot(
  state: ManagerState,
  refreshActiveAgents: () => Promise<void>,
  activeAgents: number,
): Promise<ReturnType<ManagerTools['get_manager_snapshot']>> {
  await refreshActiveAgents()
  return {
    mission: state.mission,
    runtimeMode: state.runtimeMode,
    currentPhase: state.currentPhase,
    turnStatus: state.turnStatus,
    activeAgents,
    maxConcurrency: 1,
    pendingCount: (await loadTasks()).filter((task) => task.status === 'pending').length,
    pendingQuestions: state.pendingQuestions,
    lastHeartbeat: state.lastHeartbeat,
    lastDecisionAt: state.lastDecisionAt,
    skippedWakeups: state.skippedWakeups,
    lastSkippedTriggerReason: state.lastSkippedTriggerReason,
    runtimeSessionSummary: state.runtimeSessionSummary,
    missionBranch: state.missionBranch,
    missionWorktree: state.missionWorktree,
    currentTaskId: state.currentTaskId,
    currentStage: state.currentStage,
    pendingUserMessages: state.pendingUserMessages || [],
  }
}
