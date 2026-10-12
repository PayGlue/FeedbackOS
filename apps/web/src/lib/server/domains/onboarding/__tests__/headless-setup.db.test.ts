/**
 * First-run setup over HTTP, against real Postgres rolled back after each test.
 *
 * The suite pins the contract an operator relies on: the token opens the
 * install exactly once, the account it creates really is the workspace's admin
 * and its key really works, and nothing about a wrong or spent token leaks.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createId, type PrincipalId, type UserId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { auditLog, eq, principal, settings, sql, user, postStatuses } from '@/lib/server/db'
import { getSetupState, isOnboardingComplete } from '@/lib/shared/db-types'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

const logged = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }))
vi.mock('@/lib/server/logger', () => {
  const fake: Record<string, unknown> = {
    info: (...args: unknown[]) => logged.info.push(String(args[args.length - 1])),
    warn: (...args: unknown[]) => logged.warn.push(String(args[args.length - 1])),
    error: () => undefined,
    debug: () => undefined,
    child: () => fake,
  }
  return { logger: fake }
})

import { handleSetupRequest } from '../setup-request'
import { ensureBootSetupToken, verifySetupToken } from '../headless-setup'
import { verifyApiKey } from '@/lib/server/domains/api-keys/api-key.service'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.select({ id: principal.id }).from(principal).limit(0)
    await db.select({ id: settings.id, setupState: settings.setupState }).from(settings).limit(0)
    await db.select({ id: auditLog.id }).from(auditLog).limit(0)
  },
})

const TOKEN = 'operator-chosen-setup-token-0001'
const BODY = {
  workspaceName: 'Acme Feedback',
  adminEmail: 'Dana@Example.com',
  adminName: 'Dana Admin',
}

function setupRequest(opts: { token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  const token = opts.token === undefined ? TOKEN : opts.token
  if (token) headers.authorization = `Bearer ${token}`
  return new Request('http://localhost:3000/api/v1/setup', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body === undefined ? BODY : opts.body),
  })
}

async function auditEvents(event: string) {
  return testDb.select().from(auditLog).where(eq(auditLog.eventType, event))
}

afterAll(fixture.close)

describe.skipIf(!fixture.available)('POST /api/v1/setup (real DB, rolled back)', () => {
  beforeEach(async () => {
    await fixture.begin()
    process.env.SETUP_TOKEN = TOKEN
    logged.info.length = 0
    logged.warn.length = 0
  })
  afterEach(async () => {
    delete process.env.SETUP_TOKEN
    await fixture.rollback()
  })

  it('does not exist when no token is configured', async () => {
    delete process.env.SETUP_TOKEN
    const res = await handleSetupRequest(setupRequest())
    expect(res.status).toBe(404)
  })

  it('refuses a missing or wrong token and records the attempt', async () => {
    expect((await handleSetupRequest(setupRequest({ token: null }))).status).toBe(401)
    expect((await handleSetupRequest(setupRequest({ token: `${TOKEN}x` }))).status).toBe(401)
    expect((await testDb.select().from(settings)).length).toBe(0)
    const events = await auditEvents('workspace.setup.rejected')
    expect(events.map((e) => (e.metadata as { reason: string }).reason).sort()).toEqual([
      'missing_token',
      'wrong_token',
    ])
  })

  it('ignores a token shorter than the minimum', async () => {
    process.env.SETUP_TOKEN = 'short'
    const res = await handleSetupRequest(setupRequest({ token: 'short' }))
    expect(res.status).toBe(404)
  })

  it('creates the workspace and first admin and returns a working key once', async () => {
    const res = await handleSetupRequest(setupRequest())
    expect(res.status).toBe(201)
    const { data } = (await res.json()) as {
      data: {
        workspace: { id: string; name: string; slug: string }
        admin: { userId: UserId; principalId: PrincipalId; email: string; name: string }
        apiKey: { id: string; name: string; key: string }
      }
    }
    expect(data.workspace.name).toBe('Acme Feedback')
    expect(data.admin.email).toBe('dana@example.com')
    expect(data.apiKey.key).toMatch(/^qb_[0-9a-f]{48}$/)

    const [admin] = await testDb
      .select()
      .from(principal)
      .where(eq(principal.userId, data.admin.userId))
    expect(admin?.role).toBe('admin')
    expect(admin?.type).toBe('user')
    const [account] = await testDb.select().from(user).where(eq(user.id, data.admin.userId))
    expect(account?.emailVerified).toBe(true)
    expect(account?.name).toBe('Dana Admin')

    const [row] = await testDb.select().from(settings)
    expect(isOnboardingComplete(getSetupState(row?.setupState ?? null))).toBe(true)
    expect((await testDb.select().from(postStatuses)).length).toBeGreaterThan(0)

    // The key authenticates as the admin it was minted for.
    const verified = await verifyApiKey(data.apiKey.key)
    expect(verified?.createdById).toBe(data.admin.principalId)

    const done = await auditEvents('workspace.setup.completed')
    expect(done).toHaveLength(1)
    expect(JSON.stringify(done[0])).not.toContain(data.apiKey.key)
  })

  it('is dead after the first admin exists', async () => {
    expect((await handleSetupRequest(setupRequest())).status).toBe(201)
    const again = await handleSetupRequest(
      setupRequest({ body: { ...BODY, adminEmail: 'other@example.com' } })
    )
    expect(again.status).toBe(409)
    const body = (await again.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SETUP_ALREADY_COMPLETE')
    const humans = await testDb.select().from(principal).where(eq(principal.type, 'user'))
    expect(humans.filter((p) => p.role === 'admin')).toHaveLength(1)
    // A wrong token still learns nothing about the install.
    expect(
      (await handleSetupRequest(setupRequest({ token: 'nope-nope-nope-nope-1' }))).status
    ).toBe(401)
  })

  it('validates the body', async () => {
    const res = await handleSetupRequest(
      setupRequest({ body: { ...BODY, adminEmail: 'not-an-email' } })
    )
    expect(res.status).toBe(400)
    const res2 = await handleSetupRequest(setupRequest({ body: { adminName: 'Dana Admin' } }))
    expect(res2.status).toBe(400)
    expect((await testDb.select().from(settings)).length).toBe(0)
  })

  it('takes the install even when a stray account signed up first', async () => {
    const strayId = createId('user') as UserId
    await testDb
      .insert(user)
      .values({ id: strayId, name: 'Stray', email: 'stray@example.com', emailVerified: true })
    await testDb.insert(principal).values({
      id: createId('principal') as PrincipalId,
      userId: strayId,
      role: 'user',
      type: 'user',
      createdAt: new Date(Date.now() - 60_000),
    })
    const res = await handleSetupRequest(setupRequest())
    expect(res.status).toBe(201)
    const [stray] = await testDb.select().from(principal).where(eq(principal.userId, strayId))
    expect(stray?.role).toBe('user')
  })

  it('promotes an existing account that has the given address', async () => {
    const existing = createId('user') as UserId
    await testDb
      .insert(user)
      .values({ id: existing, name: 'Dana', email: 'dana@example.com', emailVerified: true })
    await testDb.insert(principal).values({
      id: createId('principal') as PrincipalId,
      userId: existing,
      role: 'user',
      type: 'user',
      createdAt: new Date(),
    })
    const res = await handleSetupRequest(setupRequest())
    expect(res.status).toBe(201)
    const [p] = await testDb.select().from(principal).where(eq(principal.userId, existing))
    expect(p?.role).toBe('admin')
  })

  it('does not open a workspace a control plane provisioned', async () => {
    await testDb.insert(settings).values({
      id: createId('workspace'),
      name: 'Provisioned',
      slug: 'provisioned',
      createdAt: new Date(),
    })
    await testDb.execute(sql`UPDATE settings SET cloud_workspace_key = 'ws_acme'`)
    const res = await handleSetupRequest(setupRequest())
    expect(res.status).toBe(409)
  })

  it('throttles repeated attempts from one address', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await handleSetupRequest(setupRequest({ token: 'wrong-wrong-wrong-12' }))).status
      )
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
  })
})

describe.skipIf(!fixture.available)('first-boot setup token (real DB, rolled back)', () => {
  beforeEach(async () => {
    await fixture.begin()
    delete process.env.SETUP_TOKEN
    logged.info.length = 0
    logged.warn.length = 0
  })
  afterEach(fixture.rollback)

  it('prints a token once on a fresh install and accepts only that token', async () => {
    await ensureBootSetupToken()
    const line = logged.info.find((l) => l.includes('First-run setup token'))
    const token = line?.match(/(qbs_[0-9a-f]{48})/)?.[1]
    expect(token).toBeTruthy()

    expect(await verifySetupToken(token!)).toBe('ok')
    expect(await verifySetupToken('qbs_' + '0'.repeat(48))).toBe('invalid')

    // A restart does not print a second one.
    logged.info.length = 0
    await ensureBootSetupToken()
    expect(logged.info.some((l) => l.includes('First-run setup token'))).toBe(false)
    expect(await verifySetupToken(token!)).toBe('ok')

    const res = await handleSetupRequest(setupRequest({ token: token! }))
    expect(res.status).toBe(201)
  })

  it('prints nothing when the operator set a token or an admin exists', async () => {
    process.env.SETUP_TOKEN = TOKEN
    await ensureBootSetupToken()
    expect(logged.info.some((l) => l.includes('First-run setup token'))).toBe(false)
    delete process.env.SETUP_TOKEN

    const adminUser = createId('user') as UserId
    await testDb
      .insert(user)
      .values({ id: adminUser, name: 'Admin', email: 'a@example.com', emailVerified: true })
    await testDb.insert(principal).values({
      id: createId('principal') as PrincipalId,
      userId: adminUser,
      role: 'admin',
      type: 'user',
      createdAt: new Date(),
    })
    await ensureBootSetupToken()
    expect(logged.info.some((l) => l.includes('First-run setup token'))).toBe(false)
    expect(await verifySetupToken('anything-anything-1')).toBe('not_configured')
  })
})
