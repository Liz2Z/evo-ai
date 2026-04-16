import type { Task } from '../../types'
import { hasChineseCharacters } from '../../utils/task-text'
import type { ManagerTools } from '../runtime'

export interface CreateTaskDeps {
  addTaskManually: (description: string, type?: Task['type'], priority?: number) => Promise<Task>
  updateTask: (taskId: string, updates: Partial<Task>) => Promise<Task | null>
}

export async function createTask(
  { description, type = 'other', priority = 3, context }: Parameters<ManagerTools['create_task']>[0],
  deps: CreateTaskDeps,
): Promise<Task> {
  const { addTaskManually, updateTask } = deps
  const normalizedDescription = description.trim()
  if (!hasChineseCharacters(normalizedDescription)) {
    throw new Error('自动创建任务失败：任务描述必须使用中文')
  }

  const task = await addTaskManually(normalizedDescription, type, priority)
  if (context) {
    const updated = await updateTask(task.id, { context: context.trim() })
    return updated || task
  }
  return task
}
