/**
 * The approvals queue: the requests a viewer may decide, across
 * conversations, tickets, Home threads and requests with no parent, the ones
 * already decided, and one request with its diff. The reads behind the
 * Approvals page, its rail count and Home, and the REST and MCP approval
 * reads.
 *
 * The parent each row hangs off is scoped in SQL by the same rule a decision
 * checks for that one item; whether the viewer holds every permission the
 * operation needs is read per row from the operation itself. A decision checks all of
 * it again, so the queue only decides what is shown, never what is allowed.
 */
import {
  db,
  and,
  or,
  eq,
  gt,
  desc,
  exists,
  inArray,
  isNull,
  isNotNull,
  tickets,
  principal,
  user,
  assistantPendingActions,
  type ApprovalDecisionChannel,
  type ApprovalRequestChannel,
  type ApprovalRisk,
} from '@/lib/server/db'
import type { AssistantPendingActionId, PrincipalId } from '@quackback/ids'
import { ticketFilter } from '@/lib/server/policy/tickets'
import { can } from '@/lib/server/policy/authorize'
import { isTeamActor, type Actor } from '@/lib/server/policy/types'
import { PERMISSIONS, type PermissionKey } from '@/lib/shared/permissions'
import type { JsonValue } from '@/lib/shared/json'
import {
  settingsProposalSchema,
  type MessengerEffect,
} from '@/lib/shared/assistant/settings-proposals'
import { SETTINGS_PROPOSAL_TOOL } from './approval-policy'
import { isHomeThreadKey } from './workspace-safety'
import {
  approvalNotFound,
  digestForDisplay,
  approvalRiskOf,
  isDecidableApproval,
  requiredApprovalPermissions,
} from './approvals.service'

type PendingActionRow = typeof assistantPendingActions.$inferSelect

/** What changes, as the person deciding reads it. */
export type ApprovalDiff =
  | {
      kind: 'settings'
      changes: Array<{
        id: string
        area: string
        path: string[]
        before: JsonValue
        after: JsonValue
        /** An image the value stands for, such as a logo. */
        beforePreview?: string | null
        afterPreview?: string | null
        /** What else the change turns on or off. */
        effects?: MessengerEffect[]
      }>
    }
  | { kind: 'action'; args: JsonValue }

/** One request, as the queue and its reads show it. */
export interface ApprovalView {
  id: string
  toolName: string
  /** Written by the server from the diff. */
  summary: string
  risk: ApprovalRisk
  status: string
  parent: { kind: 'conversation' | 'ticket' | 'thread' | 'none'; id: string | null }
  requestedVia: ApprovalRequestChannel | null
  requestedById: string | null
  /** The name of the credential, agent or person that asked. */
  requestedByName: string | null
  onBehalfOfPrincipalId: string | null
  /** The name of the person whose authority the request borrows. */
  onBehalfOfName: string | null
  clientName: string | null
  proposedAt: string
  expiresAt: string
  /** The digest a decision on this request must name. */
  contentHash: string
  /** Approving needs an admin who signed in again; turning it down needs only an admin. */
  needsFreshSignIn: boolean
  /** The viewer may decide it now. */
  canDecide: boolean
  decidedById: string | null
  decidedByName: string | null
  decidedAt: string | null
  decidedVia: ApprovalDecisionChannel | null
  decisionReason: string | null
  /** An applied change that can still be put back. */
  undoable: boolean
  /** An applied change that was put back. */
  undone: boolean
  diff: ApprovalDiff
}

/** The requests waiting on a viewer: how many, and the newest few. */
export interface WaitingApprovals {
  count: number
  latest: ApprovalView[]
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
/** Rows read per page before the per-row permission filter. */
const SCAN_LIMIT = 200
/** How many waiting requests Home shows. */
const SUMMARY_LATEST = 3

function diffOf(row: PendingActionRow): ApprovalDiff {
  if (row.toolName === SETTINGS_PROPOSAL_TOOL) {
    const parsed = settingsProposalSchema.safeParse(row.args)
    if (parsed.success)
      return {
        kind: 'settings',
        changes: parsed.data.changes.map((change) => ({
          id: change.id,
          area: change.area,
          path: change.path,
          before: change.before as JsonValue,
          after: change.after as JsonValue,
          ...(change.beforePreview !== undefined ? { beforePreview: change.beforePreview } : {}),
          ...(change.afterPreview !== undefined ? { afterPreview: change.afterPreview } : {}),
          ...(change.effects ? { effects: change.effects } : {}),
        })),
      }
  }
  return { kind: 'action', args: row.args as JsonValue }
}

function parentOf(row: PendingActionRow): ApprovalView['parent'] {
  if (row.conversationId) return { kind: 'conversation', id: row.conversationId }
  if (row.ticketId) return { kind: 'ticket', id: row.ticketId }
  if (row.workspaceThreadKey) return { kind: 'thread', id: null }
  return { kind: 'none', id: null }
}

/** Whether an applied settings change can still be undone, and whether it was. */
function undoStateOf(row: PendingActionRow): Pick<ApprovalView, 'undoable' | 'undone'> {
  const result = row.result
  if (row.toolName !== SETTINGS_PROPOSAL_TOOL || row.status !== 'executed' || !result)
    return { undoable: false, undone: false }
  const undone = typeof result.undoneAt === 'string'
  const effects = result.storageEffects
  return { undoable: !undone && Array.isArray(effects) && effects.length > 0, undone }
}

function holdsAll(actor: Actor, required: ReadonlySet<PermissionKey>): boolean {
  return [...required].every((permission) => can(actor, permission))
}

/**
 * Whether this person is one who may decide this request, whatever state it
 * is in now: not its requester, a role its risk allows, and every permission
 * it needs. A fresh sign-in is set aside.
 */
export function qualifiesToDecide(
  row: Pick<PendingActionRow, 'requestedById' | 'risk' | 'toolName' | 'args'>,
  actor: Actor,
  required: ReadonlySet<PermissionKey>
): boolean {
  const risk = approvalRiskOf(row)
  return (
    row.requestedById !== actor.principalId &&
    risk !== 'critical' &&
    (risk !== 'high' || actor.role === 'admin') &&
    holdsAll(actor, required)
  )
}

/** Whether this viewer could decide this request now, setting aside a fresh sign-in. */
function mayDecide(row: PendingActionRow, actor: Actor, required: ReadonlySet<PermissionKey>) {
  return (
    row.status === 'proposed' &&
    row.expiresAt.getTime() > Date.now() &&
    qualifiesToDecide(row, actor, required)
  )
}

type RequirementRow = Pick<
  PendingActionRow,
  'id' | 'toolName' | 'args' | 'originRole' | 'workspaceThreadKey'
>

/**
 * What makes one request's requirement the same as another's. A settings
 * request names its own changes. A tool's depends on the role that proposed
 * it (which agent's connectors it resolves against) and on whether it came
 * from a Home thread, another thread, or none.
 */
function requirementKey(row: RequirementRow): string {
  if (row.toolName === SETTINGS_PROPOSAL_TOOL) return JSON.stringify(['settings', row.id])
  const thread = !row.workspaceThreadKey
    ? 'none'
    : isHomeThreadKey(row.workspaceThreadKey)
      ? 'home'
      : 'thread'
  return JSON.stringify([row.toolName, row.originRole, thread])
}

/**
 * The permissions each request needs, looked up once per distinct requirement
 * within one read.
 */
export function approvalRequirements(): (
  row: RequirementRow
) => Promise<ReadonlySet<PermissionKey> | null> {
  const cache = new Map<string, Promise<ReadonlySet<PermissionKey> | null>>()
  return (row) => {
    const key = requirementKey(row)
    let required = cache.get(key)
    if (!required) {
      required = requiredApprovalPermissions(row)
      cache.set(key, required)
    }
    return required
  }
}

type Names = ReadonlyMap<string, string>

function toView(
  row: PendingActionRow,
  canDecide: boolean,
  names: Names,
  contentHash: string
): ApprovalView {
  const risk = approvalRiskOf(row)
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  return {
    id: row.id,
    toolName: row.toolName,
    summary: row.summary,
    risk,
    status: row.status,
    parent: parentOf(row),
    requestedVia: row.requestedVia,
    requestedById: row.requestedById,
    requestedByName: nameOf(row.requestedById) ?? row.clientName,
    onBehalfOfPrincipalId: row.onBehalfOfPrincipalId,
    onBehalfOfName: nameOf(row.onBehalfOfPrincipalId),
    clientName: row.clientName,
    proposedAt: row.proposedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    contentHash,
    needsFreshSignIn: risk === 'high',
    canDecide,
    decidedById: row.decidedById,
    decidedByName: nameOf(row.decidedById),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedVia: row.decidedVia,
    decisionReason: row.decisionReason,
    ...undoStateOf(row),
    diff: diffOf(row),
  }
}

/** The names of everyone a set of requests mentions, in one read. */
async function namesFor(rows: readonly PendingActionRow[]): Promise<Names> {
  const ids = [
    ...new Set(
      rows.flatMap((row) => [row.requestedById, row.onBehalfOfPrincipalId, row.decidedById])
    ),
  ].filter((id): id is PrincipalId => !!id)
  if (ids.length === 0) return new Map()
  const people = await db
    .select({ id: principal.id, displayName: principal.displayName, name: user.name })
    .from(principal)
    .leftJoin(user, eq(principal.userId, user.id))
    .where(inArray(principal.id, ids))
  const names = new Map<string, string>()
  for (const person of people) {
    const name = person.name?.trim() || person.displayName?.trim()
    if (name) names.set(person.id, name)
  }
  return names
}

/** Requests as shown; showing one stores the digest a decision on it must name. */
async function toViews(
  rows: readonly PendingActionRow[],
  canDecide: (row: PendingActionRow) => boolean
): Promise<ApprovalView[]> {
  const [names, digests] = await Promise.all([
    namesFor(rows),
    Promise.all(rows.map((row) => digestForDisplay(row))),
  ])
  return rows.map((row, index) => toView(row, canDecide(row), names, digests[index]!))
}

/**
 * Rows whose parent this viewer may see, by the same rule a decision checks
 * for one item, so everyone a request is brought to can find it here. A
 * conversation is visible to any teammate who may view conversations
 * (`canViewConversation`), assigned or not; a ticket by `ticketFilter`, as
 * `assertTicketVisible` reads it. A request with no item is left to the
 * permission check.
 */
export function parentVisible(actor: Actor) {
  return or(
    and(isNull(assistantPendingActions.conversationId), isNull(assistantPendingActions.ticketId)),
    can(actor, PERMISSIONS.CONVERSATION_VIEW)
      ? isNotNull(assistantPendingActions.conversationId)
      : undefined,
    exists(
      db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.id, assistantPendingActions.ticketId), ticketFilter(actor)))
    )
  )
}

/** Only teammates decide: a person, never a credential, agent or portal user. */
function isTeammate(actor: Actor): boolean {
  return actor.principalType === 'user' && !!actor.principalId && isTeamActor(actor)
}

/** The pending rows this viewer may decide, newest first, up to `limit`. */
async function waitingRowsFor(actor: Actor, limit: number): Promise<PendingActionRow[]> {
  if (!isTeammate(actor)) return []
  const rows = await db
    .select()
    .from(assistantPendingActions)
    .where(
      and(
        eq(assistantPendingActions.status, 'proposed'),
        gt(assistantPendingActions.expiresAt, new Date()),
        parentVisible(actor)
      )
    )
    // Ids are time-ordered, so they break a tie between requests filed together.
    .orderBy(desc(assistantPendingActions.proposedAt), desc(assistantPendingActions.id))
    .limit(SCAN_LIMIT)
  const requiredFor = approvalRequirements()
  const decidable: PendingActionRow[] = []
  for (const row of rows) {
    if (decidable.length >= limit) break
    if (!isDecidableApproval(row)) continue
    const required = await requiredFor(row)
    if (required && mayDecide(row, actor, required)) decidable.push(row)
  }
  return decidable
}

/**
 * The pending requests this viewer may decide, newest first. Only people
 * decide, so a credential or agent sees an empty queue.
 */
export async function listApprovalsForViewer(
  actor: Actor,
  options: { limit?: number } = {}
): Promise<ApprovalView[]> {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  return toViews(await waitingRowsFor(actor, limit), () => true)
}

/**
 * How many requests wait on this viewer, and the newest few: the rail's count
 * and Home's list, in one read.
 */
export async function waitingApprovalsSummary(actor: Actor): Promise<WaitingApprovals> {
  const rows = await waitingRowsFor(actor, MAX_LIMIT)
  return { count: rows.length, latest: await toViews(rows.slice(0, SUMMARY_LATEST), () => true) }
}

/**
 * Requests already decided that this viewer could have decided, decided
 * themselves, or that were filed on their behalf, most recently decided
 * first.
 */
export async function listDecidedApprovalsForViewer(
  actor: Actor,
  options: { limit?: number } = {}
): Promise<ApprovalView[]> {
  if (!isTeammate(actor)) return []
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  const rows = await db
    .select()
    .from(assistantPendingActions)
    .where(and(isNotNull(assistantPendingActions.decidedAt), parentVisible(actor)))
    .orderBy(desc(assistantPendingActions.decidedAt), desc(assistantPendingActions.id))
    .limit(SCAN_LIMIT)
  const requiredFor = approvalRequirements()
  const shown: PendingActionRow[] = []
  for (const row of rows) {
    if (shown.length >= limit) break
    if (!isDecidableApproval(row)) continue
    const involved =
      row.decidedById === actor.principalId || row.onBehalfOfPrincipalId === actor.principalId
    const required = involved ? null : await requiredFor(row)
    if (involved || (required && holdsAll(actor, required))) shown.push(row)
  }
  return toViews(shown, () => false)
}

/**
 * One request with its diff, for a viewer who may decide it or on whose
 * behalf it was filed. Anything else reads as not found, the same as a
 * request that does not exist.
 */
export async function getApprovalForViewer(
  actor: Actor,
  id: AssistantPendingActionId
): Promise<ApprovalView> {
  if (!isTeammate(actor)) throw approvalNotFound()
  const [row] = await db
    .select()
    .from(assistantPendingActions)
    .where(and(eq(assistantPendingActions.id, id), parentVisible(actor)))
    .limit(1)
  if (!row || !isDecidableApproval(row)) throw approvalNotFound()
  const required = await requiredApprovalPermissions(row)
  const qualified = !!required && holdsAll(actor, required)
  if (
    !qualified &&
    row.onBehalfOfPrincipalId !== actor.principalId &&
    row.decidedById !== actor.principalId
  )
    throw approvalNotFound()
  const [view] = await toViews([row], () => !!required && mayDecide(row, actor, required))
  return view!
}
