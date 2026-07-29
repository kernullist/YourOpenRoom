// Pure open-thread selection, split out of aoiRelationshipState so the client
// can use it too: the store module touches node fs, and importing it by value
// from browser code would break the client bundle. One implementation, two
// consumers -- the server writer and the greeting -- so the asked-once rule
// cannot drift between them.

export interface AoiRelationshipThreadLike {
  id: string;
  title: string;
  noticedAt: number;
  // Absent means Aoi has never raised this thread.
  lastAskedAt?: number;
}

// The one thread worth raising: the oldest never-asked thread. Returns null once
// every open thread has been raised, which is what keeps a follow-up question
// from turning into nagging -- asking again is worse than not asking.
export function selectAoiRelationshipThreadToRaise<T extends AoiRelationshipThreadLike>(
  threads: readonly T[] | null | undefined,
): T | null {
  if (!threads || threads.length === 0) {
    return null;
  }
  const unasked = threads
    .filter((thread) => thread.lastAskedAt === undefined)
    .sort((left, right) => left.noticedAt - right.noticedAt);
  return unasked[0] ?? null;
}
