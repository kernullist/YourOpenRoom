// Pure open-thread selection, split out of aoiRelationshipState so the client
// can use it too: the store module touches node fs, and importing it by value
// from browser code would break the client bundle. One implementation, two
// consumers -- the server writer and the greeting -- so the asked-once rule
// cannot drift between them.

export const MAX_AOI_RELATIONSHIP_RECORDED_THREADS = 8;

// Which strategic-brief threads belong on the relationship record.
//
// Accepted proposals only. blockedThreads looks like a peer of openThreads but is
// diagnostic text: synthesizeAoiStrategicBrief composes each entry as
// "<title> -- <policy reason>", so it carries internal blocker codes such as
// too_many_active_proposals. Recording those put them in front of the persona
// bridge, which frames the list as "Still unresolved between you" -- and a policy
// block is not something the user left unresolved with Aoi. They never agreed to
// it, and answering cannot clear it: saying yes does not raise the proposal cap.
// Asking would be a question with no available answer, which is exactly what the
// asked-once rule exists to avoid. The governor and situation panels already
// render the blocked set with its reasons; that is where that text belongs.
export function selectAoiRelationshipThreadTitles(brief: {
  readonly openThreads?: readonly string[] | null;
  readonly blockedThreads?: readonly string[] | null;
}): string[] {
  return (brief.openThreads ?? [])
    .map((title) => (typeof title === 'string' ? title.trim() : ''))
    .filter((title) => title.length > 0)
    .slice(0, MAX_AOI_RELATIONSHIP_RECORDED_THREADS);
}

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
