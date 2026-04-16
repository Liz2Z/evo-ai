import { loadHistory } from '../../utils/storage'
import type { ManagerTools } from '../runtime'

export async function getRecentHistory(
  input?: Parameters<ManagerTools['get_recent_history']>[0],
): Promise<ReturnType<ManagerTools['get_recent_history']>> {
  const history = await loadHistory()
  return history.slice(-(input?.limit || 20))
}
