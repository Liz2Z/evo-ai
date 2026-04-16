import { loadAgents } from '../../utils/storage'
import type { ManagerTools } from '../runtime'

export async function listAgents(): Promise<ReturnType<ManagerTools['list_agents']>> {
  return loadAgents()
}
