/**
 * Tests for the Parsec issue-tracker capability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parsecIssues } from '@/integrations/parsec/server/issues'

const config = {
  apiUrl: 'https://api.example.com',
  webUrl: 'https://tracker.example.com',
  projectRef: 'acme.PROJ',
}

describe('parsecIssues.parseRef', () => {
  const parseRef = parsecIssues.parseRef!

  it('reads a bare key and builds the URL', () => {
    expect(parseRef('proj-42', config)).toEqual({
      externalId: 'PROJ-42',
      externalDisplayId: 'PROJ-42',
      externalUrl: 'https://tracker.example.com/acme/issue/PROJ-42',
    })
  })

  it('reads an issue URL', () => {
    const url = 'https://tracker.example.com/acme/issue/PROJ-42?tab=activity'
    expect(parseRef(url, config)?.externalId).toBe('PROJ-42')
  })

  it('returns null for something that is no reference', () => {
    expect(parseRef('not an issue', config)).toBeNull()
  })

  it('refuses another instance', () => {
    expect(() => parseRef('https://other.example.com/acme/issue/PROJ-42', config)).toThrow(
      /connected instance/
    )
  })

  it('refuses another project', () => {
    expect(() => parseRef('OTHER-42', config)).toThrow(/connected project/)
  })
})

describe('parsecIssues.create', () => {
  const create = parsecIssues.create!
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const auth = { ...config, accessToken: 'key' }
  const columns = [
    { id: 2, name: 'Todo', stateType: 'unstarted', position: 1 },
    { id: 1, name: 'Backlog', stateType: 'backlog', position: 0 },
    { id: 3, name: 'Done', stateType: 'completed', position: 2 },
  ]

  it('creates the issue in the first open column', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ columns }))
      .mockResolvedValueOnce(Response.json({ identifier: 'PROJ-43' }, { status: 201 }))

    const ref = await create({ auth, title: 'Broken', bodyMarkdown: 'Details' })

    expect(ref).toEqual({
      externalId: 'PROJ-43',
      externalDisplayId: 'PROJ-43',
      externalUrl: 'https://tracker.example.com/acme/issue/PROJ-43',
    })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://api.example.com/projects/acme.PROJ/issues')
    expect(init.headers['x-api-key']).toBe('key')
    expect(JSON.parse(init.body)).toEqual({ columnId: 1, title: 'Broken', description: 'Details' })
  })

  it('fails without a project', async () => {
    await expect(
      create({ auth: { ...auth, projectRef: undefined }, title: 'x', bodyMarkdown: '' })
    ).rejects.toThrow(/No Parsec project/)
  })

  it('marks a server error as retryable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(create({ auth, title: 'x', bodyMarkdown: '' })).rejects.toMatchObject({
      status: 503,
      retryable: true,
    })
  })
})
