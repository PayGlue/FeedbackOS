/**
 * What a visitor typed into the feed while it loaded. The loading state and
 * the loaded feed are different trees, so the swap between them would drop
 * it: the loading state leaves it here as it unmounts and the loaded feed
 * takes it as it mounts. Anything not taken within a moment is stale (the
 * visitor went elsewhere) and is dropped.
 */
interface FeedInput {
  /** The composer's title; empty when the visitor only clicked into it. */
  composeTitle?: string
  /** A search not yet applied when the loading state went. */
  search?: string
}

const FRESH_MS = 2000

let pending: (FeedInput & { at: number }) | null = null

/** The pending input, or null once it has gone stale (dropping it then). */
function fresh(): (FeedInput & { at: number }) | null {
  if (pending && Date.now() - pending.at > FRESH_MS) pending = null
  return pending
}

export function handOffFeedInput(input: FeedInput): void {
  // Stale input is dropped first, so new input cannot renew its timestamp.
  pending = { ...fresh(), ...input, at: Date.now() }
}

export function takeFeedInput<K extends keyof FeedInput>(key: K): FeedInput[K] {
  const current = fresh()
  if (!current) return undefined
  const value = current[key]
  delete current[key]
  return value
}
