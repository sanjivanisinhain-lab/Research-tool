// Count participants, not mentions: combined audiences de-duplicate by participant ID.
export function countUniqueParticipants(groups: string[][]): number {
  const set = new Set<string>();
  for (const g of groups) for (const id of g) set.add(id);
  return set.size;
}
