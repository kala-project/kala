export function visibleFileEntries<T extends { name: string }>(entries: readonly T[], showHidden: boolean): T[] {
  return entries.filter((entry) => showHidden || !entry.name.startsWith('.'))
}
