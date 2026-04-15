export function hasChineseCharacters(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text)
}
