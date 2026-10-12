/**
 * What the settings registry does on behalf of a caller, whatever the surface:
 * list the areas, read one, change one (preview, apply, or file an approval)
 * and undo a receipt.
 *
 * The REST routes and the MCP tools call these and only translate the result
 * to their own wire format, so a rule such as "medium risk needs an approval"
 * lives once.
 */
import { and, auditLog, db, eq, principal, settings, user, type Transaction } from '@/lib/server/db'
import type { Actor } from '@/lib/server/policy/types'
import { permissionsForPrincipal } from '@/lib/server/policy/permissions'
import {
  ConflictError,
  LockedError,
  NotFoundError,
  PreconditionFailedError,
  PreconditionRequiredError,
} from '@/lib/shared/errors'
import type {
  LockedField,
  SettingsArea,
  SettingsChangeEntry,
  SettingsReceipt,
  SettingsRisk,
} from '@/lib/shared/settings-registry'
import { recordAuditEventInTransaction } from '@/lib/server/audit/log'
import {
  requireSettings,
  invalidateSettingsCache,
} from '@/lib/server/domains/settings/settings.helpers'
import { requireAreaPermission } from '@/lib/server/domains/assistant/settings-proposals.areas'
import type { SettingsApplyReceipt } from '@/lib/server/domains/assistant/settings-proposals.storage'
import { prepareSettingsChanges } from '@/lib/server/domains/assistant/settings-proposals.service'
import {
  enqueueWorkspaceSettingsProposal,
  undoWorkspaceSettingsProposal,
} from '@/lib/server/domains/assistant/workspace-settings-actions.service'
import type { ApprovalRequester } from '@/lib/server/domains/assistant/approvals.service'
import { settingsProposalRisk } from '@/lib/server/domains/assistant/approval-policy'
import { assistantPendingActions } from '@/lib/server/db'
import { settingsReceiptIdSchema } from '@/lib/shared/settings-registry'
import {
  getSettingsArea,
  parseAreaPatch,
  SETTINGS_REGISTRY,
  type SettingsAreaEntry,
} from './registry'
import { approvalUrl } from '@/lib/server/domains/assistant/approvals.follow'

/** Who is asking and how the request arrived. */
export interface SettingsCaller {
  actor: Actor
  /** Recorded on an approval this call files. */
  requester: ApprovalRequester
  /**
   * The caller is a person signed in to the app. A key or an OAuth client is
   * not, and may not undo an approved change without a person deciding it.
   */
  signedInSession?: boolean
  /** Checks the credential's own scope for an area it is about to write. */
  assertAreaScope?: (area: SettingsArea) => void
}

/** What a caller must hold or pass for a change to an area to take effect. */
export interface SettingsGates {
  permission: string
  /** `required`: the change is filed as an approval and applied when a person decides it. */
  approval: 'none' | 'required'
  /** A person must have signed in again just before deciding. */
  freshSignIn: boolean
}

export interface SettingsAreaSummary {
  id: SettingsArea
  title: string
  description: string
  risk: SettingsRisk
  revision: string
  locked: LockedField[]
  gates: SettingsGates
}

export interface SettingsAreaRead extends SettingsAreaSummary {
  value: Record<string, unknown>
  /** Whether each secret field is set. No area holds one yet. */
  secrets: Record<string, boolean>
}

function gatesOf(entry: SettingsAreaEntry): SettingsGates {
  return {
    permission: entry.permission,
    approval: entry.risk === 'low' ? 'none' : 'required',
    freshSignIn: entry.risk === 'high' || entry.risk === 'critical',
  }
}

function summaryOf(entry: SettingsAreaEntry, row: Awaited<ReturnType<typeof requireSettings>>) {
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    risk: entry.risk,
    revision: entry.revision(row),
    locked: entry.lockedFields(row),
    gates: gatesOf(entry),
  }
}

/** The areas the actor may read, with each one's risk, revision and gates. */
export async function listSettingsAreas(actor: Actor): Promise<SettingsAreaSummary[]> {
  const row = await requireSettings(db)
  const held = actor.principalId ? await heldPermissions(actor) : new Set<string>()
  return Object.values(SETTINGS_REGISTRY)
    .filter((entry) => held.has(entry.permission))
    .map((entry) => summaryOf(entry, row))
}

async function heldPermissions(actor: Actor): Promise<Set<string>> {
  const [record] = await db
    .select({ role: principal.role })
    .from(principal)
    .where(eq(principal.id, actor.principalId!))
    .limit(1)
  if (!record || (record.role !== 'admin' && record.role !== 'member')) return new Set()
  const stored = await permissionsForPrincipal(actor.principalId!, record.role)
  return new Set(
    [...stored].filter((permission) => !actor.permissions || actor.permissions.has(permission))
  )
}

/** One area's value, revision and locked fields. */
export async function readSettingsArea(actor: Actor, id: string): Promise<SettingsAreaRead> {
  const entry = getSettingsArea(id)
  await requireAreaPermission(actor, entry.id, db)
  const row = await requireSettings(db)
  const value = entry.read(row)
  return {
    ...summaryOf(entry, row),
    value,
    secrets: Object.fromEntries(
      entry.secretFields.map((field) => [field, value[`${field}Set`]])
    ) as Record<string, boolean>,
  }
}

export interface ChangeSettingsInput {
  patch: unknown
  /** The revision the caller read. Required unless this is a dry run. */
  expectedRevision?: string | null
  dryRun?: boolean
}

export interface SettingsPreview {
  area: SettingsArea
  risk: SettingsRisk
  revision: string
  /** The change would be filed as an approval, not applied. */
  requiresApproval: boolean
  changes: SettingsChangeEntry[]
}

/** The approval a medium-risk change was filed as. */
export interface FiledApproval {
  proposed: true
  approvalId: string
  /** The same id, under the name earlier clients read. */
  pendingActionId: string
  status: 'pending'
  /** The in-app page where a person decides it. */
  url: string
  next: string
  proposal: unknown
  preparationNotes?: unknown
  reviewHref?: string
}

export type ChangeSettingsResult =
  | { status: 'dry_run'; preview: SettingsPreview }
  | { status: 'noop'; revision: string }
  | { status: 'applied'; receipt: SettingsReceipt }
  | { status: 'approval_required'; approval: FiledApproval }

/** Strip the quotes and weak marker an If-Match value may carry. */
export function normalizeRevision(header: string): string {
  return header
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1')
}

/** A patch that moves a locked field to a value other than the one it holds is refused. */
function assertNotLocked(
  entry: SettingsAreaEntry,
  row: Awaited<ReturnType<typeof requireSettings>>,
  patch: Record<string, unknown>
): void {
  const current = entry.read(row)
  const touched = entry
    .lockedFields(row)
    .filter(
      (lock) =>
        lock.field in patch &&
        JSON.stringify(patch[lock.field]) !== JSON.stringify(current[lock.field])
    )
  if (touched.length > 0)
    throw new LockedError(
      'FIELD_LOCKED',
      `${touched.map((lock) => lock.field).join(', ')} cannot be changed here: ${
        touched.some((lock) => lock.reason === 'config_file')
          ? "managed by your administrator's config"
          : 'managed by the workspace operator'
      }.`,
      { locked: touched }
    )
}

function assertRevision(
  entry: SettingsAreaEntry,
  row: Awaited<ReturnType<typeof requireSettings>>,
  expected: string
): string {
  const current = entry.revision(row)
  if (normalizeRevision(expected) !== current)
    throw new PreconditionFailedError(
      'REVISION_MISMATCH',
      'These settings changed since you read them. Read them again and resend the change.',
      { revision: current }
    )
  return current
}

async function auditActor(tx: Transaction, actor: Actor) {
  const [person] = await tx
    .select({ userId: principal.userId, email: user.email })
    .from(principal)
    .leftJoin(user, eq(principal.userId, user.id))
    .where(eq(principal.id, actor.principalId!))
    .limit(1)
  return { userId: person?.userId, email: person?.email, role: actor.role, type: 'user' as const }
}

/** The approval fields every surface returns for a filed change. */
function filedApproval(action: {
  id: string
  args: unknown
  preparationNotes?: unknown
  reviewHref?: string
}): FiledApproval {
  return {
    proposed: true,
    approvalId: action.id,
    pendingActionId: action.id,
    status: 'pending',
    url: approvalUrl(action.id),
    next: 'Nothing changes until a person approves this in the app, at url. Check its progress with get_approval.',
    proposal: action.args,
    ...(action.preparationNotes ? { preparationNotes: action.preparationNotes } : {}),
    ...(action.reviewHref ? { reviewHref: action.reviewHref } : {}),
  }
}

/**
 * Change one area. A low-risk change applies at once, in one transaction that
 * also writes its audit event and returns a receipt. A medium-risk or higher
 * change, judged from the diff itself, is filed as an approval, the same one
 * `propose_settings_change` files, and nothing is written until a person
 * decides it.
 */
export async function changeSettingsArea(
  caller: SettingsCaller,
  id: string,
  input: ChangeSettingsInput
): Promise<ChangeSettingsResult> {
  const entry = getSettingsArea(id)
  const { actor } = caller
  const patch = parseAreaPatch(entry, input.patch)
  caller.assertAreaScope?.(entry.id)
  await requireAreaPermission(actor, entry.id, db)
  const row = await requireSettings(db)
  assertNotLocked(entry, row, patch)
  const expected = input.expectedRevision?.trim()
  const revision = expected ? assertRevision(entry, row, expected) : entry.revision(row)

  let proposal: Awaited<ReturnType<typeof prepareSettingsChanges>> | null = null
  try {
    proposal = await prepareSettingsChanges(actor, [{ area: entry.id, patch } as never])
  } catch (error) {
    if ((error as { code?: string }).code !== 'SETTINGS_ALREADY_MATCH') throw error
  }
  // The diff decides the tier, so a bulk change is medium on every surface.
  const risk: SettingsRisk = proposal ? settingsProposalRisk(proposal) : entry.risk

  if (input.dryRun) {
    return {
      status: 'dry_run',
      preview: {
        area: entry.id,
        risk,
        revision,
        requiresApproval: risk !== 'low' && proposal !== null,
        changes:
          proposal?.changes.map(({ path, before, after }) => ({ path, before, after })) ?? [],
      },
    }
  }
  if (!expected)
    throw new PreconditionRequiredError(
      'IF_MATCH_REQUIRED',
      'Send the revision you read as If-Match.'
    )
  if (!proposal) return { status: 'noop', revision }

  if (risk !== 'low') {
    const action = await enqueueWorkspaceSettingsProposal(
      actor,
      [{ area: entry.id, patch }],
      undefined,
      undefined,
      caller.requester,
      // The row is locked while the card is filed, so a write that landed
      // after the check above is a mismatch, not a card built on old values.
      async (tx) => {
        const [locked] = await tx.select().from(settings).limit(1).for('update')
        if (!locked) throw new NotFoundError('SETTINGS_NOT_FOUND', 'Settings not found')
        assertNotLocked(entry, locked, patch)
        assertRevision(entry, locked, expected)
      }
    )
    return { status: 'approval_required', approval: filedApproval(action) }
  }

  return applyLocked(caller, entry, patch, expected)
}

async function applyLocked(
  caller: SettingsCaller,
  entry: SettingsAreaEntry,
  patch: Record<string, unknown>,
  expected: string
): Promise<ChangeSettingsResult> {
  const { actor } = caller
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(settings).limit(1).for('update')
    if (!locked) throw new NotFoundError('SETTINGS_NOT_FOUND', 'Settings not found')
    assertNotLocked(entry, locked, patch)
    assertRevision(entry, locked, expected)
    const outcome = await entry.apply(tx, actor, patch)
    if (!outcome.receipt) return { outcome, receiptId: null, revision: entry.revision(locked) }
    const [after] = await tx.select().from(settings).limit(1)
    const revision = entry.revision(after)
    const receiptId = await recordAuditEventInTransaction(tx, {
      event: 'settings.applied',
      actor: await auditActor(tx, actor),
      target: { type: 'settings_area', id: entry.id },
      before: outcome.receipt.changes.map((change) => ({ id: change.id, value: change.before })),
      after: outcome.receipt.changes.map((change) => ({ id: change.id, value: change.after })),
      metadata: {
        area: entry.id,
        risk: entry.risk,
        revision,
        principalId: actor.principalId,
        receipt: outcome.receipt,
      },
    })
    return { outcome, receiptId, revision }
  })
  if (!result.outcome.receipt || !result.receiptId)
    return { status: 'noop', revision: result.revision }
  await invalidateSettingsCache()
  return {
    status: 'applied',
    receipt: {
      id: result.receiptId,
      area: entry.id,
      appliedAt: result.outcome.receipt.appliedAt,
      revision: result.revision,
      changes: result.outcome.changes,
      before: result.outcome.before,
      after: result.outcome.after,
      undoable: result.outcome.receipt.storageEffects.length > 0,
    },
  }
}

export interface UndoSettingsResult {
  id: string
  area: SettingsArea | null
  undone: true
  undoneAt: string
}

export type UndoSettingsOutcome =
  | { status: 'undone'; result: UndoSettingsResult }
  | { status: 'approval_required'; approval: FiledApproval }

/**
 * Undo a receipt while the values it wrote have not moved. A receipt is the
 * audit row of a direct (low-risk) write, or an approval a person decided.
 *
 * Undoing an approved change that touched a medium-risk or higher area is
 * itself a change to that area, so unless a signed-in person asks, the inverse
 * is filed as a new approval instead of being applied.
 */
export async function undoSettingsReceipt(
  caller: SettingsCaller,
  receiptId: string
): Promise<UndoSettingsOutcome> {
  const { actor } = caller
  const parsed = settingsReceiptIdSchema.safeParse(receiptId)
  if (!parsed.success)
    throw new NotFoundError('SETTINGS_RECEIPT_NOT_FOUND', 'Settings receipt not found')
  if (receiptId.startsWith('assistant_action_')) return undoApproval(caller, receiptId)
  const result = await db.transaction(async (tx) => {
    const [receiptRow] = await tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.id, receiptId as never), eq(auditLog.eventType, 'settings.applied')))
      .limit(1)
    const receipt = (receiptRow?.metadata as { receipt?: SettingsApplyReceipt } | null)?.receipt
    if (!receiptRow || !receipt)
      throw new NotFoundError('SETTINGS_RECEIPT_NOT_FOUND', 'Settings receipt not found')
    const entry = getSettingsArea(receiptRow.targetId ?? '')
    caller.assertAreaScope?.(entry.id)
    // Serialise undo and apply on the one settings row.
    await tx.select({ id: settings.id }).from(settings).limit(1).for('update')
    const [already] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.eventType, 'settings.undone'), eq(auditLog.targetId, receiptId)))
      .limit(1)
    if (already)
      throw new ConflictError('SETTINGS_UNDO_UNAVAILABLE', 'This change was already undone')
    try {
      await entry.undo(tx, actor, receipt)
    } catch (error) {
      if ((error as { code?: string }).code === 'SETTINGS_UNDO_CONFLICT')
        throw new ConflictError('SETTINGS_UNDO_CONFLICT', (error as Error).message)
      throw error
    }
    await recordAuditEventInTransaction(tx, {
      event: 'settings.undone',
      actor: await auditActor(tx, actor),
      target: { type: 'settings_receipt', id: receiptId },
      before: receipt.changes.map((change) => ({ id: change.id, value: change.after })),
      after: receipt.changes.map((change) => ({ id: change.id, value: change.before })),
      metadata: { area: receiptRow.targetId, principalId: actor.principalId },
    })
    return entry.id
  })
  await invalidateSettingsCache()
  return {
    status: 'undone',
    result: { id: receiptId, area: result, undone: true, undoneAt: new Date().toISOString() },
  }
}

async function undoApproval(caller: SettingsCaller, id: string): Promise<UndoSettingsOutcome> {
  const { actor } = caller
  const [row] = await db
    .select()
    .from(assistantPendingActions)
    .where(eq(assistantPendingActions.id, id as never))
    .limit(1)
  const receipt = row?.result as unknown as SettingsApplyReceipt | null
  if (!row || row.toolName !== 'propose_settings_change' || !receipt?.changes)
    throw new NotFoundError('SETTINGS_RECEIPT_NOT_FOUND', 'Settings receipt not found')
  if (row.status !== 'executed' || (row.result as { undoneAt?: string }).undoneAt)
    throw new ConflictError('SETTINGS_UNDO_UNAVAILABLE', 'This change cannot be undone')
  const areas = [...new Set(receipt.changes.map((change) => change.area))]
  for (const area of areas) {
    caller.assertAreaScope?.(area)
    await requireAreaPermission(actor, area, db)
  }

  if (!caller.signedInSession && settingsProposalRisk(receipt) !== 'low') {
    // The inverse: each changed value goes back to what it was.
    const patches = new Map<SettingsArea, Record<string, unknown>>()
    for (const change of receipt.changes) {
      const patch = patches.get(change.area) ?? {}
      let target = patch
      for (const key of change.path.slice(0, -1))
        target = (target[key] ??= {}) as Record<string, unknown>
      target[change.path.at(-1)!] = change.before
      patches.set(change.area, patch)
    }
    const inputs = [...patches].map(([area, patch]) => {
      parseAreaPatch(getSettingsArea(area), patch)
      return { area, patch }
    })
    const action = await enqueueWorkspaceSettingsProposal(
      actor,
      inputs,
      undefined,
      undefined,
      caller.requester
    )
    return { status: 'approval_required', approval: filedApproval(action) }
  }

  const undone = await undoWorkspaceSettingsProposal(actor, id as never, 'settings.undone')
  return {
    status: 'undone',
    result: {
      id,
      area: areas.length === 1 ? areas[0] : null,
      undone: true,
      undoneAt: String((undone.result as { undoneAt?: string } | null)?.undoneAt),
    },
  }
}
