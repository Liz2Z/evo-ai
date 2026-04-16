import type { Question } from '../../types'
import { addQuestion } from '../../utils/storage'
import type { ManagerTools } from '../runtime'

export interface AskHumanDeps {
  state: { pendingQuestions: Question[]; currentPhase: string }
  setState: (updates: Partial<{ pendingQuestions: Question[] }>) => Promise<void>
}

export async function askHuman(
  { question, options }: Parameters<ManagerTools['ask_human']>[0],
  deps: AskHumanDeps,
): Promise<Question> {
  const { state, setState } = deps

  const existing = state.pendingQuestions.find(
    (item) => !item.answered && item.question.trim() === question.trim(),
  )
  if (existing) return existing

  const created: Question = {
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    options: options || [],
    createdAt: new Date().toISOString(),
    source: state.currentPhase,
  }
  await addQuestion(created)

  await setState({
    pendingQuestions: [...state.pendingQuestions, created],
  })

  return created
}
