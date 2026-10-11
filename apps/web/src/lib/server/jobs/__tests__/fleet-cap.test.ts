/**
 * The fleet-wide cap counts running jobs, not polls.
 *
 * Every workspace loop polls about once a second, and almost every poll finds
 * nothing. A cap spent by polls in flight would be held by idle workspaces
 * while a slow database stretches each claim, which is exactly when the cap
 * matters, and a workspace with real work due could not ask for it.
 */
import { describe, expect, it, vi } from 'vitest'

const { inFlight, asked } = vi.hoisted(() => ({
  inFlight: [] as Array<(rows: unknown[]) => void>,
  asked: [] as Array<Array<{ queue: string; limit: number }>>,
}))

vi.mock('@/lib/server/logger', () => {
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child: () => quiet }
  return { logger: quiet }
})
vi.mock('@/lib/server/workspaces/workspace-context', () => ({ getCurrentWorkspace: () => null }))
vi.mock('../job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../job-queue')>()),
  // A claim that stays in flight until the test settles it: a slow database.
  claimJobs: (input: { specs: Array<{ queue: string; limit: number }> }) => {
    asked.push(input.specs.map(({ queue, limit }) => ({ queue, limit })))
    return new Promise((resolve) => inFlight.push(resolve as (rows: unknown[]) => void))
  },
}))

import { __setJobDefinitionsForTests } from '../definitions'
import { createJobPool, dispatchPass, runnerConfig } from '../runner'

describe('the fleet-wide cap', () => {
  it('is not held by polls that are still waiting on the database', async () => {
    __setJobDefinitionsForTests([
      { name: 'heavy', fleetConcurrency: 2, handler: async () => async () => {} },
      { name: 'light', concurrency: 5, handler: async () => async () => {} },
    ])
    const config = { ...runnerConfig(), batchSize: 10, maxConcurrency: 50 }
    const run = async () => 'succeeded' as const

    // Three workspaces poll and their claims hang on a slow database.
    const idle = [1, 2, 3].map(() => dispatchPass({ pool: createJobPool(), config, run }))
    await vi.waitFor(() => expect(asked).toHaveLength(3))

    // A fourth polls meanwhile. Nothing is running, so the cap is all free.
    const fourth = dispatchPass({ pool: createJobPool(), config, run })
    await vi.waitFor(() => expect(asked).toHaveLength(4))
    expect(asked[3]).toContainEqual({ queue: 'heavy', limit: 1 })

    inFlight.splice(0).forEach((settle) => settle([]))
    await Promise.all([...idle, fourth])
    __setJobDefinitionsForTests(null)
  })
})
