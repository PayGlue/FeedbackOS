/**
 * Incident and maintenance lifecycle against real Postgres: the paths whose
 * correctness depends on the SQL (the reconcile query's active set, the
 * soft-delete filters, transaction rollback) rather than on call order.
 *
 * Event dispatch and the delayed-job scheduler are stubbed; everything else
 * runs for real inside the fixture's always-rolled-back transaction.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createId, type PrincipalId, type StatusComponentId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import {
  and,
  eq,
  isNull,
  sql,
  principal,
  statusComponents,
  statusComponentEvents,
  statusIncidentComponents,
  statusIncidents,
  statusIncidentUpdates,
} from '@/lib/server/db'
import { ValidationError } from '@/lib/shared/errors'
import { ANONYMOUS_ACTOR } from '@/lib/server/policy/types'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

const mockProcessEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/server/events/process', () => ({
  processEvent: (...args: unknown[]) => mockProcessEvent(...args),
}))

vi.mock('@/lib/server/events/scheduler', () => ({
  scheduleDispatch: vi.fn().mockResolvedValue(undefined),
  cancelScheduledDispatch: vi.fn().mockResolvedValue(undefined),
}))

import { scheduleDispatch } from '@/lib/server/events/scheduler'
import {
  createStatusComponent,
  deleteStatusComponent,
  setComponentStatus,
} from '../status.components'
import {
  createIncident,
  createStatusIncidentTemplate,
  deleteIncident,
  findStatusIncidentById,
  getStatusIncidentById,
  listStatusIncidents,
  listStatusIncidentTemplates,
  notifyStatusIncidentPublished,
  postIncidentUpdate,
  reconcileStatusNotifications,
  updateIncident,
} from '../status.service'
import {
  handleMaintenanceComplete,
  handleMaintenanceStart,
  reconcileMaintenanceWindows,
  startMaintenanceNow,
} from '../status.maintenance'
import { getStatusPageSnapshot } from '../status.public'

const statements: { query: string; params: unknown[] }[] = []
const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db
      .select({ id: statusIncidents.id, notify: statusIncidents.notifySubscribers })
      .from(statusIncidents)
      .limit(0)
  },
  logger: { logQuery: (query, params) => statements.push({ query, params }) },
})

const HOUR = 60 * 60 * 1000
let author: PrincipalId

async function service(name: string): Promise<StatusComponentId> {
  return (await createStatusComponent({ name })).id
}

async function openIncident(
  affected: {
    componentId: StatusComponentId
    componentStatus: 'major_outage' | 'degraded_performance'
  }[]
) {
  return createIncident(
    {
      kind: 'incident',
      title: 'Errors',
      status: 'investigating',
      body: 'Looking into it.',
      affectedComponents: affected,
      notifySubscribers: false,
    },
    { principalId: author }
  )
}

async function scheduleWindow(start: Date, end: Date | null) {
  const db = await service('Database')
  return createIncident(
    {
      kind: 'maintenance',
      title: 'Upgrade',
      status: 'scheduled',
      body: 'Planned upgrade.',
      affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
      scheduledStartAt: start,
      scheduledEndAt: end,
      notifySubscribers: false,
    },
    { principalId: author }
  )
}

function isRecent(date: Date) {
  return Math.abs(Date.now() - date.getTime()) < 60_000
}

async function statusOf(id: StatusComponentId) {
  const row = await testDb.query.statusComponents.findFirst({
    where: eq(statusComponents.id, id),
  })
  return row?.status
}

describe('status lifecycle (Postgres)', () => {
  beforeEach(async () => {
    expect(fixture.available).toBe(true)
    mockProcessEvent.mockReset().mockResolvedValue(undefined)
    await fixture.begin()
    author = createId('principal')
    await testDb
      .insert(principal)
      .values({ id: author, role: 'admin', type: 'service', createdAt: new Date() })
  })
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  describe('a service deleted while an incident uses it', () => {
    it('resolving the incident still restores its other services', async () => {
      const api = await service('API')
      const web = await service('Website')
      const incident = await createIncident(
        {
          kind: 'incident',
          title: 'Errors',
          status: 'investigating',
          body: 'Looking into it.',
          affectedComponents: [
            { componentId: api, componentStatus: 'major_outage' },
            { componentId: web, componentStatus: 'partial_outage' },
          ],
          notifySubscribers: false,
        },
        { principalId: author }
      )
      expect(await statusOf(web)).toBe('partial_outage')

      await deleteStatusComponent(api)
      const resolved = await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )

      expect(resolved.status).toBe('resolved')
      expect(resolved.resolvedAt).not.toBeNull()
      expect(await statusOf(web)).toBe('operational')
    })

    it('leaves the deleted service out of the detail, and keeps its link when the editor saves', async () => {
      const api = await service('API')
      const web = await service('Website')
      const incident = await createIncident(
        {
          kind: 'incident',
          title: 'Errors',
          status: 'investigating',
          body: 'Looking into it.',
          affectedComponents: [
            { componentId: api, componentStatus: 'major_outage' },
            { componentId: web, componentStatus: 'partial_outage' },
          ],
          notifySubscribers: false,
        },
        { principalId: author }
      )
      await deleteStatusComponent(api)

      const detail = await getStatusIncidentById(incident.id)
      expect(detail.affectedComponents.map((c) => c.componentId)).toEqual([web])

      // A stale editor still sends the deleted service back; it is ignored
      // rather than relinked, and its existing link survives as history.
      const saved = await updateIncident(incident.id, {
        title: 'Elevated errors',
        affectedComponents: [
          { componentId: api, componentStatus: 'major_outage' },
          { componentId: web, componentStatus: 'degraded_performance' },
        ],
      })
      expect(saved.affectedComponents).toEqual([
        expect.objectContaining({ componentId: web, componentStatus: 'degraded_performance' }),
      ])
      const links = await testDb.query.statusIncidentComponents.findMany({
        where: eq(statusIncidentComponents.incidentId, incident.id),
      })
      expect(links.map((l) => l.componentId).sort()).toEqual([api, web].sort())
      expect(await statusOf(web)).toBe('degraded_performance')
    })

    it('tells a stale editor whose every service was deleted that, not that none was chosen', async () => {
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await deleteStatusComponent(api)

      await expect(
        updateIncident(incident.id, {
          title: 'Elevated errors',
          affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
        })
      ).rejects.toThrow('An affected service has been deleted. Choose the services again.')
    })

    it('maintenance auto-complete still completes the window and restores the rest', async () => {
      const db = await service('Database')
      const api = await service('API')
      const window = await createIncident(
        {
          kind: 'maintenance',
          title: 'Upgrade',
          status: 'in_progress',
          body: 'Upgrading.',
          affectedComponents: [
            { componentId: db, componentStatus: 'under_maintenance' },
            { componentId: api, componentStatus: 'under_maintenance' },
          ],
          scheduledStartAt: new Date(Date.now() - 2 * HOUR),
          scheduledEndAt: new Date(Date.now() - HOUR),
          notifySubscribers: false,
        },
        { principalId: author }
      )
      expect(await statusOf(api)).toBe('under_maintenance')

      await deleteStatusComponent(db)
      await handleMaintenanceComplete(window.id)

      const after = await getStatusIncidentById(window.id)
      expect(after.status).toBe('completed')
      expect(await statusOf(api)).toBe('operational')
    })

    it('templates offer only the services that still exist', async () => {
      const api = await service('API')
      const web = await service('Website')
      await createStatusIncidentTemplate({
        name: 'Outage',
        title: 'Outage',
        body: 'We are investigating.',
        componentIds: [api, web],
      })
      await deleteStatusComponent(api)

      const [template] = await listStatusIncidentTemplates()
      expect(template.componentIds).toEqual([web])
    })
  })

  describe('creating an incident', () => {
    it('rejects a deleted service and writes nothing', async () => {
      const api = await service('API')
      await deleteStatusComponent(api)

      const attempt = createIncident(
        {
          kind: 'incident',
          title: 'Errors',
          status: 'investigating',
          body: 'Looking into it.',
          affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
        },
        { principalId: author }
      )
      await expect(attempt).rejects.toBeInstanceOf(ValidationError)
      // Worded for API callers as well as the dashboard: no "refresh the page".
      await expect(attempt).rejects.toThrow(
        'An affected service has been deleted. Choose the services again.'
      )
      expect(await testDb.query.statusIncidents.findMany()).toEqual([])
    })

    it('created already resolved, it is stamped resolved and leaves its services alone', async () => {
      const api = await service('API')
      await setComponentStatus(api, 'degraded_performance', 'manual')

      const resolved = await createIncident(
        {
          kind: 'incident',
          title: 'Blip',
          status: 'resolved',
          body: 'A short blip, already over.',
          affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
          notifySubscribers: false,
        },
        { principalId: author }
      )
      expect(resolved.resolvedAt).not.toBeNull()
      expect(isRecent(resolved.resolvedAt!)).toBe(true)
      expect(resolved.startedAt.getTime()).toBeLessThanOrEqual(resolved.resolvedAt!.getTime())
      // It never held the service, so neither outage nor restore applies.
      expect(await statusOf(api)).toBe('degraded_performance')
      expect((await listStatusIncidents({ kind: 'incident', state: 'active' })).items).toEqual([])
      expect(
        (await listStatusIncidents({ kind: 'incident', state: 'resolved' })).items.map((i) => i.id)
      ).toEqual([resolved.id])
    })

    it('a window created already completed is stamped resolved, dated by its plan, and holds nothing', async () => {
      const db = await service('Database')
      const plan = new Date(Date.now() - 3 * HOUR)
      const window = await createIncident(
        {
          kind: 'maintenance',
          title: 'Upgrade',
          status: 'completed',
          body: 'Done last night.',
          affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
          scheduledStartAt: plan,
          scheduledEndAt: new Date(plan.getTime() + HOUR),
          notifySubscribers: false,
        },
        { principalId: author }
      )
      expect(isRecent(window.resolvedAt!)).toBe(true)
      expect(window.startedAt.getTime()).toBe(plan.getTime())
      expect(await statusOf(db)).toBe('operational')
      expect(await reconcileMaintenanceWindows()).toEqual({ started: 0, completed: 0 })
    })

    it('is atomic: a failure after the incident row is written leaves nothing behind', async () => {
      const api = await service('API')

      // The same service twice violates the link table's primary key, after
      // the incident row itself has already been inserted.
      await expect(
        createIncident(
          {
            kind: 'incident',
            title: 'Errors',
            status: 'investigating',
            body: 'Looking into it.',
            affectedComponents: [
              { componentId: api, componentStatus: 'major_outage' },
              { componentId: api, componentStatus: 'partial_outage' },
            ],
          },
          { principalId: author }
        )
      ).rejects.toThrow()

      expect(await testDb.query.statusIncidents.findMany()).toEqual([])
      expect(await testDb.query.statusIncidentComponents.findMany()).toEqual([])
      expect(await statusOf(api)).toBe('operational')
    })
  })

  describe('deleting an incident', () => {
    it('releases the services it held, but not ones another open incident still holds', async () => {
      const api = await service('API')
      const web = await service('Website')
      const first = await openIncident([
        { componentId: api, componentStatus: 'major_outage' },
        { componentId: web, componentStatus: 'major_outage' },
      ])
      const second = await openIncident([
        { componentId: api, componentStatus: 'degraded_performance' },
      ])

      await deleteIncident(first.id)
      expect(await statusOf(web)).toBe('operational')
      expect(await statusOf(api)).toBe('degraded_performance')

      await deleteIncident(second.id)
      expect(await statusOf(api)).toBe('operational')
    })

    it('leaves services alone when the row was not holding them', async () => {
      const start = new Date(Date.now() + 24 * HOUR)
      const window = await scheduleWindow(start, new Date(start.getTime() + HOUR))
      const [link] = window.affectedComponents
      await setComponentStatus(link.componentId, 'degraded_performance', 'manual')

      await deleteIncident(window.id)
      expect(await statusOf(link.componentId)).toBe('degraded_performance')

      const api = await service('API')
      const resolved = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await postIncidentUpdate(
        resolved.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )
      await setComponentStatus(api, 'partial_outage', 'api')

      await deleteIncident(resolved.id)
      expect(await statusOf(api)).toBe('partial_outage')
    })

    it('reads back as missing (null) for the editor, not as an error', async () => {
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      expect((await findStatusIncidentById(incident.id))?.id).toBe(incident.id)

      await deleteIncident(incident.id)
      expect(await findStatusIncidentById(incident.id)).toBeNull()
      expect(await findStatusIncidentById(createId('status_incident'))).toBeNull()
    })
  })

  describe('a row that is not holding its services', () => {
    it('leaves a status set since alone when its details are saved', async () => {
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )
      await setComponentStatus(api, 'degraded_performance', 'manual')

      // The editor's autosave always sends the services back.
      await updateIncident(incident.id, {
        title: 'Elevated errors on the API',
        affectedComponents: [{ componentId: api, componentStatus: 'partial_outage' }],
      })
      expect(await statusOf(api)).toBe('degraded_performance')
    })

    it('leaves it alone when a terminal update is posted', async () => {
      const start = new Date(Date.now() + 24 * HOUR)
      const window = await scheduleWindow(start, new Date(start.getTime() + HOUR))
      const [link] = window.affectedComponents
      await setComponentStatus(link.componentId, 'degraded_performance', 'api')

      // Called off before it ever started.
      await postIncidentUpdate(
        window.id,
        { status: 'completed', body: 'Called off.' },
        { principalId: author }
      )
      expect(await statusOf(link.componentId)).toBe('degraded_performance')

      // A further note on a resolved incident.
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )
      await setComponentStatus(api, 'partial_outage', 'manual')
      await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Root cause: a bad deploy.' },
        { principalId: author }
      )
      expect(await statusOf(api)).toBe('partial_outage')
    })

    it('leaves it alone when the scheduler completes a window that never started', async () => {
      const window = await scheduleWindow(
        new Date(Date.now() - 2 * HOUR),
        new Date(Date.now() - HOUR)
      )
      await updateIncident(window.id, { autoStart: false })
      const [link] = window.affectedComponents
      await setComponentStatus(link.componentId, 'degraded_performance', 'api')

      await handleMaintenanceComplete(window.id)
      expect((await getStatusIncidentById(window.id)).status).toBe('completed')
      expect(await statusOf(link.componentId)).toBe('degraded_performance')
    })

    it('still recomputes a holding row whose services change', async () => {
      const api = await service('API')
      const web = await service('Website')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])

      await updateIncident(incident.id, {
        affectedComponents: [{ componentId: web, componentStatus: 'partial_outage' }],
      })
      expect(await statusOf(api)).toBe('operational')
      expect(await statusOf(web)).toBe('partial_outage')
    })
  })

  describe('reopening', () => {
    it('a resolved incident clears resolvedAt, rejoins the open lists and holds its services again', async () => {
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )
      expect(await statusOf(api)).toBe('operational')
      // Make the first resolution clearly older than any later one.
      await testDb
        .update(statusIncidents)
        .set({ resolvedAt: new Date(Date.now() - 2 * HOUR) })
        .where(eq(statusIncidents.id, incident.id))

      const reopened = await postIncidentUpdate(
        incident.id,
        { status: 'monitoring', body: 'It is back.' },
        { principalId: author }
      )
      expect(reopened.status).toBe('monitoring')
      expect(reopened.resolvedAt).toBeNull()
      expect(await statusOf(api)).toBe('major_outage')
      const open = await listStatusIncidents({ kind: 'incident', state: 'active' })
      expect(open.items.map((i) => i.id)).toEqual([incident.id])
      const snapshot = await getStatusPageSnapshot(ANONYMOUS_ACTOR, { pageDescription: '' })
      expect(snapshot.activeIncidents.map((i) => i.id)).toEqual([incident.id])

      const resolvedAgain = await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed for real.' },
        { principalId: author }
      )
      expect(resolvedAgain.resolvedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000)
      expect(await statusOf(api)).toBe('operational')
    })

    it('a completed window goes back to holding its services and is not re-completed by the sweep', async () => {
      const db = await service('Database')
      const window = await createIncident(
        {
          kind: 'maintenance',
          title: 'Upgrade',
          status: 'in_progress',
          body: 'Upgrading.',
          affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
          scheduledStartAt: new Date(Date.now() - 2 * HOUR),
          scheduledEndAt: new Date(Date.now() - HOUR),
          notifySubscribers: false,
        },
        { principalId: author }
      )
      await handleMaintenanceComplete(window.id)
      expect(await statusOf(db)).toBe('operational')

      const reopened = await postIncidentUpdate(
        window.id,
        { status: 'verifying', body: 'Still checking replicas.' },
        { principalId: author }
      )
      expect(reopened.resolvedAt).toBeNull()
      // Its end has passed, so auto-complete would close it again at once.
      expect(reopened.autoComplete).toBe(false)
      expect(await statusOf(db)).toBe('under_maintenance')

      await reconcileMaintenanceWindows()
      expect((await getStatusIncidentById(window.id)).status).toBe('verifying')
    })

    it('a running window moved back to scheduled is not restarted by the sweep', async () => {
      const db = await service('Database')
      const window = await createIncident(
        {
          kind: 'maintenance',
          title: 'Upgrade',
          status: 'in_progress',
          body: 'Upgrading.',
          affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
          scheduledStartAt: new Date(Date.now() - HOUR),
          scheduledEndAt: new Date(Date.now() + HOUR),
          notifySubscribers: false,
        },
        { principalId: author }
      )

      const moved = await postIncidentUpdate(
        window.id,
        { status: 'scheduled', body: 'Not yet, rescheduling.' },
        { principalId: author }
      )
      expect(moved.autoStart).toBe(false)
      expect(await statusOf(db)).toBe('operational')

      await reconcileMaintenanceWindows()
      expect((await getStatusIncidentById(window.id)).status).toBe('scheduled')
    })
  })

  describe('maintenance start time', () => {
    it('holds the planned start until the window starts, and follows a reschedule', async () => {
      const start = new Date(Date.now() + 24 * HOUR)
      const window = await scheduleWindow(start, new Date(start.getTime() + HOUR))
      expect(window.startedAt.getTime()).toBe(start.getTime())

      const later = new Date(start.getTime() + 2 * HOUR)
      const moved = await updateIncident(window.id, {
        scheduledStartAt: later,
        scheduledEndAt: new Date(later.getTime() + HOUR),
      })
      expect(moved.startedAt.getTime()).toBe(later.getTime())
    })

    it('records the real start when the scheduler starts the window', async () => {
      const window = await scheduleWindow(new Date(Date.now() - HOUR), new Date(Date.now() + HOUR))
      await handleMaintenanceStart(window.id)
      const started = await getStatusIncidentById(window.id)
      expect(started.status).toBe('in_progress')
      expect(isRecent(started.startedAt)).toBe(true)
      // Its timeline row is dated at the same instant, to the millisecond.
      expect(started.updates.find((u) => u.status === 'in_progress')?.createdAt).toEqual(
        started.startedAt
      )
    })

    it('records the real start on "Start now" and on a posted in-progress update, and keeps the plan', async () => {
      const plannedStart = new Date(Date.now() + 24 * HOUR)
      const plannedEnd = new Date(plannedStart.getTime() + 2 * HOUR)

      const early = await scheduleWindow(plannedStart, plannedEnd)
      vi.mocked(scheduleDispatch).mockClear()
      const before = Date.now()
      await startMaintenanceNow(early.id)
      const started = await getStatusIncidentById(early.id)
      expect(started.status).toBe('in_progress')
      expect(isRecent(started.startedAt)).toBe(true)
      expect(started.scheduledStartAt?.getTime()).toBe(plannedStart.getTime())
      expect(started.scheduledEndAt?.getTime()).toBe(plannedEnd.getTime())
      // Completion stays armed for the planned end.
      const completion = vi
        .mocked(scheduleDispatch)
        .mock.calls.map(([job]) => job)
        .find((job) => job.handler === '__status_maintenance_complete__')
      expect(completion?.delayMs).toBeLessThanOrEqual(plannedEnd.getTime() - before)
      expect(completion?.delayMs).toBeGreaterThan(plannedEnd.getTime() - before - 60_000)

      const posted = await scheduleWindow(plannedStart, plannedEnd)
      const after = await postIncidentUpdate(
        posted.id,
        { status: 'in_progress', body: 'Starting early.' },
        { principalId: author }
      )
      expect(isRecent(after.startedAt)).toBe(true)
      expect(after.updates.find((u) => u.status === 'in_progress')?.createdAt).toEqual(
        after.startedAt
      )
      expect(after.scheduledStartAt?.getTime()).toBe(plannedStart.getTime())
      expect(after.scheduledEndAt?.getTime()).toBe(plannedEnd.getTime())

      // Both still complete on their own at the planned end.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(plannedEnd.getTime() + 60_000)
        expect(await reconcileMaintenanceWindows()).toEqual({ started: 0, completed: 2 })
      } finally {
        vi.useRealTimers()
      }
      expect((await getStatusIncidentById(early.id)).status).toBe('completed')
      expect((await getStatusIncidentById(posted.id)).status).toBe('completed')
    })

    it('a window started early and moved back to scheduled holds its plan again', async () => {
      const plannedStart = new Date(Date.now() + 24 * HOUR)
      const window = await scheduleWindow(plannedStart, new Date(plannedStart.getTime() + HOUR))
      await startMaintenanceNow(window.id)

      const moved = await postIncidentUpdate(
        window.id,
        { status: 'scheduled', body: 'Not yet after all.' },
        { principalId: author }
      )
      expect(moved.startedAt.getTime()).toBe(plannedStart.getTime())
      // The plan is still ahead, so it starts on its own then.
      expect(moved.autoStart).toBe(true)
    })

    it('rejects a window that ends before it starts, on create and on update', async () => {
      const start = new Date(Date.now() + 24 * HOUR)
      await expect(scheduleWindow(start, new Date(start.getTime() - HOUR))).rejects.toBeInstanceOf(
        ValidationError
      )

      const window = await scheduleWindow(start, new Date(start.getTime() + HOUR))
      await expect(
        updateIncident(window.id, { scheduledEndAt: new Date(start.getTime() - HOUR) })
      ).rejects.toBeInstanceOf(ValidationError)
      await expect(
        updateIncident(window.id, { scheduledStartAt: new Date(start.getTime() + 2 * HOUR) })
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('migration 0298 dates existing windows by their real or planned start, and a replay changes nothing', async () => {
      const day = 24 * HOUR
      const now = Date.now()
      type Legacy = {
        status: 'scheduled' | 'in_progress' | 'completed'
        created: number
        start: number
        completed?: number
        /** When the window was started (an in_progress update), if it was. */
        begun?: number
      }
      const rows: Record<string, Legacy> = {
        upcoming: { status: 'scheduled', created: now - day, start: now + day },
        planPassed: { status: 'scheduled', created: now - 3 * day, start: now - 2 * day },
        createdUnderWay: { status: 'scheduled', created: now - HOUR, start: now - 2 * HOUR },
        // "Start now" a day ahead of the planned start.
        startedEarlyByHand: {
          status: 'in_progress',
          created: now - 3 * day,
          start: now - day,
          begun: now - 2 * day,
        },
        // Moved straight from scheduled to completed: its completion update is
        // not when it started, or it would have lasted no time at all.
        completedWithoutStart: {
          status: 'completed',
          created: now - 3 * day,
          start: now - 2 * day,
          completed: now - day,
        },
        // Completed (called off) before its planned start: the plan would put
        // started_at after resolved_at, so it keeps its creation time.
        completedBeforePlan: {
          status: 'completed',
          created: now - 3 * day,
          start: now + day,
          completed: now - 2 * day,
        },
        // Completed without starting, then moved to in progress, which kept
        // resolved_at: its start update came after it was resolved, and
        // started_at must not end up after resolved_at.
        reopenedAfterCompleting: {
          status: 'in_progress',
          created: now - 3 * day,
          start: now - 2 * day,
          completed: now - day,
          begun: now - 12 * HOUR,
        },
        // Started early by hand, then moved back to scheduled: a window still
        // scheduled holds its plan, as the app writes it.
        movedBackToScheduled: {
          status: 'scheduled',
          created: now - 3 * day,
          start: now + day,
          begun: now - 2 * day,
        },
      }
      const ids: Record<string, string> = {}
      for (const [name, row] of Object.entries(rows)) {
        const [inserted] = await testDb
          .insert(statusIncidents)
          .values({
            kind: 'maintenance',
            title: name,
            status: row.status,
            impact: 'maintenance',
            scheduledStartAt: new Date(row.start),
            startedAt: new Date(row.created),
            resolvedAt: row.completed ? new Date(row.completed) : null,
          })
          .returning({ id: statusIncidents.id })
        ids[name] = inserted.id
        for (const [status, at] of [
          ['completed', row.completed],
          ['in_progress', row.begun],
        ] as const) {
          if (at === undefined) continue
          await testDb
            .insert(statusIncidentUpdates)
            .values({ incidentId: inserted.id, status, body: status, createdAt: new Date(at) })
        }
      }
      const [incident] = await testDb
        .insert(statusIncidents)
        .values({
          kind: 'incident',
          title: 'incident',
          status: 'investigating',
          scheduledStartAt: new Date(now + day),
          startedAt: new Date(now - day),
        })
        .returning({ id: statusIncidents.id })

      const migration = readFileSync(
        resolve(process.cwd(), 'packages/db/drizzle/0298_status_maintenance_started_at.sql'),
        'utf8'
      )
      await testDb.execute(sql.raw(migration))
      await testDb.execute(sql.raw(migration))

      const startedAt = async (id: string) =>
        (await testDb.query.statusIncidents.findFirst({
          where: eq(statusIncidents.id, id as never),
        }))!.startedAt.getTime()
      expect(await startedAt(ids.upcoming)).toBe(rows.upcoming.start)
      expect(await startedAt(ids.planPassed)).toBe(rows.planPassed.start)
      expect(await startedAt(ids.createdUnderWay)).toBe(rows.createdUnderWay.created)
      expect(await startedAt(ids.startedEarlyByHand)).toBe(rows.startedEarlyByHand.begun)
      expect(await startedAt(ids.completedWithoutStart)).toBe(rows.completedWithoutStart.start)
      expect(await startedAt(ids.completedBeforePlan)).toBe(rows.completedBeforePlan.created)
      expect(await startedAt(ids.reopenedAfterCompleting)).toBe(
        rows.reopenedAfterCompleting.created
      )
      expect(await startedAt(ids.movedBackToScheduled)).toBe(rows.movedBackToScheduled.start)
      expect(await startedAt(incident.id)).toBe(now - day)

      // Then the app runs, and a gap heal replays the migration. Nothing the
      // app wrote in between, new windows or ones from before, may move.
      // The app's clock runs an hour behind the database's here: a start
      // dated by one clock and its timeline row by the other would show.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(now - HOUR)
        const tick = () => vi.setSystemTime(Date.now() + 60_000)
        const post = (id: string, status: 'in_progress' | 'scheduled' | 'completed') =>
          postIncidentUpdate(id as never, { status, body: status }, { principalId: author })
        const inAnHour = () => new Date(Date.now() + HOUR)
        const anHourAgo = () => new Date(Date.now() - HOUR)

        const byScheduler = await scheduleWindow(anHourAgo(), inAnHour())
        tick()
        await handleMaintenanceStart(byScheduler.id)

        const byPost = await scheduleWindow(inAnHour(), new Date(Date.now() + 2 * HOUR))
        tick()
        await post(byPost.id, 'in_progress')

        const db = await service('Database')
        await createIncident(
          {
            kind: 'maintenance',
            title: 'Upgrade',
            status: 'in_progress',
            body: 'Upgrading.',
            affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
            scheduledStartAt: anHourAgo(),
            scheduledEndAt: inAnHour(),
            notifySubscribers: false,
          },
          { principalId: author }
        )

        // Completed without starting, then reopened as in progress.
        const reopened = await scheduleWindow(anHourAgo(), inAnHour())
        tick()
        await post(reopened.id, 'completed')
        tick()
        await post(reopened.id, 'in_progress')

        // Started, then moved back to scheduled with its plan behind it.
        const movedBack = await scheduleWindow(anHourAgo(), inAnHour())
        tick()
        await handleMaintenanceStart(movedBack.id)
        tick()
        await post(movedBack.id, 'scheduled')

        // Completed without starting, then its plan corrected.
        const replanned = await scheduleWindow(
          new Date(Date.now() - 3 * HOUR),
          new Date(Date.now() - 2 * HOUR)
        )
        tick()
        await post(replanned.id, 'completed')
        await updateIncident(replanned.id, {
          scheduledStartAt: new Date(Date.now() - 150 * 60_000),
        })

        // Started, moved back to scheduled, then completed from there, by
        // hand and by the scheduler once its end has passed.
        const backThenDone = await scheduleWindow(anHourAgo(), inAnHour())
        const backThenSwept = await scheduleWindow(anHourAgo(), inAnHour())
        tick()
        await handleMaintenanceStart(backThenDone.id)
        await handleMaintenanceStart(backThenSwept.id)
        tick()
        await post(backThenDone.id, 'scheduled')
        await post(backThenSwept.id, 'scheduled')
        tick()
        await post(backThenDone.id, 'completed')
        vi.setSystemTime(Date.now() + 2 * HOUR)
        await handleMaintenanceComplete(backThenSwept.id)

        // A window from before the migration, completed now.
        await post(ids.reopenedAfterCompleting, 'completed')
      } finally {
        vi.useRealTimers()
      }

      const windows = async () =>
        Object.fromEntries(
          (
            await testDb.query.statusIncidents.findMany({
              where: eq(statusIncidents.kind, 'maintenance'),
            })
          ).map((w) => [w.title === 'Upgrade' ? w.id : `${w.title} ${w.id}`, w.startedAt.getTime()])
        )
      const beforeReplay = await windows()
      await testDb.execute(sql.raw(migration))
      expect(await windows()).toEqual(beforeReplay)
    })

    it('a window completed straight from scheduled keeps its planned start, never one after it completed', async () => {
      const plan = new Date(Date.now() - 2 * HOUR)
      const ran = await scheduleWindow(plan, new Date(plan.getTime() + HOUR))
      const completed = await postIncidentUpdate(
        ran.id,
        { status: 'completed', body: 'Done.' },
        { principalId: author }
      )
      expect(completed.startedAt.getTime()).toBe(plan.getTime())
      expect(isRecent(completed.resolvedAt!)).toBe(true)

      // Called off before its planned start: it can't have started later
      // than it finished.
      const future = new Date(Date.now() + 24 * HOUR)
      const calledOff = await scheduleWindow(future, new Date(future.getTime() + HOUR))
      const cancelled = await postIncidentUpdate(
        calledOff.id,
        { status: 'completed', body: 'Called off.' },
        { principalId: author }
      )
      expect(cancelled.startedAt.getTime()).toBeLessThanOrEqual(cancelled.resolvedAt!.getTime())
    })
  })

  describe('publishing with "Email subscribers" off', () => {
    it('is never sent, by this version or by an older one rolled back to', async () => {
      const api = await service('API')
      const quiet = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      expect(quiet.notifySubscribers).toBe(false)

      const actor = { type: 'service' as const, displayName: 'test' }
      expect(await notifyStatusIncidentPublished(quiet.id, actor)).toBe(false)

      // A row that asked for the email and was never claimed (the process
      // died before the fire-and-forget send) is still picked up.
      const [pending] = await testDb
        .insert(statusIncidents)
        .values({ kind: 'incident', title: 'Pending', status: 'investigating' })
        .returning({ id: statusIncidents.id })
      expect(await reconcileStatusNotifications()).toBe(1)
      expect((await getStatusIncidentById(pending.id)).notifiedAt).not.toBeNull()
      const published = mockProcessEvent.mock.calls.filter(
        ([event]) => (event as { type: string }).type === 'status.incident_created'
      )
      expect(published).toHaveLength(1)

      // A version without notify_subscribers sweeps every live row with no
      // notified_at. Rolled back to, or as an old worker mid-deploy, it must
      // still find nothing here to announce.
      const releasedSweep = await testDb
        .select({ id: statusIncidents.id })
        .from(statusIncidents)
        .where(
          and(
            isNull(statusIncidents.notifiedAt),
            eq(statusIncidents.backfilled, false),
            isNull(statusIncidents.deletedAt)
          )
        )
      expect(releasedSweep).toEqual([])
    })
  })

  describe('logging a past incident', () => {
    it('rejects one resolved before it started', async () => {
      const api = await service('API')
      const start = new Date(Date.now() - 2 * HOUR)
      await expect(
        createIncident(
          {
            kind: 'incident',
            title: 'Old outage',
            status: 'resolved',
            body: 'It happened.',
            affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
            backfill: { startedAt: start, resolvedAt: new Date(start.getTime() - HOUR) },
          },
          { principalId: author }
        )
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('adds history without touching uptime or service status', async () => {
      const api = await service('API')
      const start = new Date(Date.now() - 3 * HOUR)
      const logged = await createIncident(
        {
          kind: 'incident',
          title: 'Old outage',
          status: 'resolved',
          body: 'It happened.',
          affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
          backfill: { startedAt: start, resolvedAt: new Date(start.getTime() + HOUR) },
        },
        { principalId: author }
      )

      expect(logged.backfilled).toBe(true)
      expect(logged.startedAt.getTime()).toBe(start.getTime())
      // Its summary is dated at the resolution, not at the moment it was logged.
      expect(logged.updates.map((u) => u.createdAt.getTime())).toEqual([start.getTime() + HOUR])
      expect(await statusOf(api)).toBe('operational')
      // Uptime bars derive from this log; a backfill writes nothing to it.
      expect(
        await testDb.query.statusComponentEvents.findMany({
          where: eq(statusComponentEvents.componentId, api),
        })
      ).toEqual([])
    })

    it('stays history: it is never live, on create or by a later update', async () => {
      const api = await service('API')
      const start = new Date(Date.now() - 3 * HOUR)
      const backfill = { startedAt: start, resolvedAt: new Date(start.getTime() + HOUR) }
      const past = {
        kind: 'incident' as const,
        title: 'Old outage',
        body: 'It happened.',
        affectedComponents: [{ componentId: api, componentStatus: 'major_outage' as const }],
        backfill,
      }

      await expect(
        createIncident({ ...past, status: 'investigating' }, { principalId: author })
      ).rejects.toThrow('A past incident is logged as resolved. Use the "resolved" status.')

      const logged = await createIncident({ ...past, status: 'resolved' }, { principalId: author })
      await expect(
        postIncidentUpdate(
          logged.id,
          { status: 'monitoring', body: 'It is back.' },
          { principalId: author }
        )
      ).rejects.toThrow("A logged past incident can't be reopened. Report a new incident instead.")

      const after = await getStatusIncidentById(logged.id)
      expect(after.status).toBe('resolved')
      expect(after.resolvedAt?.getTime()).toBe(backfill.resolvedAt.getTime())
      expect(after.updates).toHaveLength(1)
      expect(await statusOf(api)).toBe('operational')
      expect((await listStatusIncidents({ kind: 'incident', state: 'active' })).items).toEqual([])

      // A note on it, still resolved, is fine.
      const noted = await postIncidentUpdate(
        logged.id,
        { status: 'resolved', body: 'Root cause: an expired certificate.' },
        { principalId: author }
      )
      expect(noted.updates).toHaveLength(2)
      expect(noted.resolvedAt?.getTime()).toBe(backfill.resolvedAt.getTime())
    })
  })

  describe('the maintenance sweep', () => {
    it('only loads windows that can still need action', async () => {
      const db = await service('Database')
      const past = {
        affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' as const }],
        scheduledStartAt: new Date(Date.now() - 3 * HOUR),
        scheduledEndAt: new Date(Date.now() - 2 * HOUR),
        notifySubscribers: false,
      }
      const done = await createIncident(
        { ...past, kind: 'maintenance', title: 'Done', status: 'in_progress', body: 'Running.' },
        { principalId: author }
      )
      await handleMaintenanceComplete(done.id)
      const overdue = await createIncident(
        { ...past, kind: 'maintenance', title: 'Overdue', status: 'in_progress', body: 'Running.' },
        { principalId: author }
      )

      statements.length = 0
      expect(await reconcileMaintenanceWindows()).toEqual({ started: 0, completed: 1 })
      expect((await getStatusIncidentById(overdue.id)).status).toBe('completed')

      // The sweep's own read excludes completed windows in SQL, rather than
      // loading every past window and skipping them in code.
      const sweepRead = statements.find(
        (s) => /from "status_incidents"/.test(s.query) && /"scheduled_end_at" <= /.test(s.query)
      )
      expect(sweepRead?.query).toMatch(/\."status" <> \$\d+ and [^)]*"auto_complete"/)
      expect(sweepRead?.params).toContain('completed')
    })

    /** Runs `handler` with its read of the window answered from before
     *  `other` ran: the job and the sweep (or "Start now") both read the
     *  window, then both write. */
    async function raceOnStaleRead(handler: () => Promise<void>, other: () => Promise<void>) {
      const read = testDb.query.statusIncidents
      const realFindFirst = read.findFirst.bind(read)
      const spy = vi.spyOn(read, 'findFirst').mockImplementationOnce((async (
        config: Parameters<typeof realFindFirst>[0]
      ) => {
        const stale = await realFindFirst(config)
        await other()
        return stale
      }) as never)
      try {
        await handler()
      } finally {
        spy.mockRestore()
      }
    }

    function dispatched(type: string) {
      return mockProcessEvent.mock.calls.filter(
        ([event]) => (event as { type: string }).type === type
      )
    }

    it('starts a window once when two callers read it as scheduled', async () => {
      const window = await scheduleWindow(new Date(Date.now() - HOUR), new Date(Date.now() + HOUR))
      await raceOnStaleRead(
        () => handleMaintenanceStart(window.id),
        () => handleMaintenanceStart(window.id)
      )

      const started = await getStatusIncidentById(window.id)
      expect(started.status).toBe('in_progress')
      expect(started.updates.filter((u) => u.status === 'in_progress')).toHaveLength(1)
      expect(dispatched('status.maintenance_started')).toHaveLength(1)

      // "Start now" that loses the same race says the window can't be started.
      const other = await scheduleWindow(
        new Date(Date.now() + HOUR),
        new Date(Date.now() + 2 * HOUR)
      )
      let lost: unknown
      await raceOnStaleRead(
        () => startMaintenanceNow(other.id).catch((err: unknown) => void (lost = err)),
        () => startMaintenanceNow(other.id)
      )
      expect(lost).toBeInstanceOf(ValidationError)
      expect(
        (await getStatusIncidentById(other.id)).updates.filter((u) => u.status === 'in_progress')
      ).toHaveLength(1)
    })

    it('completes a window once when two callers read it as running', async () => {
      const db = await service('Database')
      const window = await createIncident(
        {
          kind: 'maintenance',
          title: 'Upgrade',
          status: 'in_progress',
          body: 'Upgrading.',
          affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
          scheduledStartAt: new Date(Date.now() - 2 * HOUR),
          scheduledEndAt: new Date(Date.now() - HOUR),
          notifySubscribers: false,
        },
        { principalId: author }
      )
      await raceOnStaleRead(
        () => handleMaintenanceComplete(window.id),
        () => handleMaintenanceComplete(window.id)
      )

      const completed = await getStatusIncidentById(window.id)
      expect(completed.status).toBe('completed')
      expect(completed.updates.filter((u) => u.status === 'completed')).toHaveLength(1)
      expect(dispatched('status.maintenance_completed')).toHaveLength(1)
    })
  })
})
