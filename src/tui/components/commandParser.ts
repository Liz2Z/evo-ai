export const COMMAND_HELP_TEXT =
  'Commands: /answer /pause /resume /task /cancel /mission [--force] /help | Plain text = message to manager'

export interface MissionCommandInput {
  mission: string
  force: boolean
}

export function parseMissionCommand(text: string): MissionCommandInput | null {
  if (!text.startsWith('/mission')) return null

  const rest = text.slice('/mission'.length).trim()
  if (!rest) return null

  const missionParts: string[] = []
  let force = false

  for (const part of rest.split(/\s+/)) {
    if (part === '--force') {
      force = true
      continue
    }
    missionParts.push(part)
  }

  const mission = missionParts.join(' ').trim()
  if (!mission) return null

  return { mission, force }
}
