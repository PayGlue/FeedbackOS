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

  it('reads a bare number as an issue in the connected project', () => {
    expect(parseRef('42', config)?.externalId).toBe('PROJ-42')
    expect(parseRef(' #42 ', config)?.externalId).toBe('PROJ-42')
  })

  it('needs a connected project for a bare number', () => {
    expect(parseRef('42', { ...config, projectRef: undefined })).toBeNull()
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
  const issueTypes = [
    { id: 7, name: 'Task', isDefault: true },
    { id: 8, name: 'Support', isDefault: false },
  ]

  const setup = { columns, issueTypes, assignees: [] }

  it('creates the issue in the first open column with the project default type', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(setup))
      .mockResolvedValueOnce(Response.json({ id: 9, identifier: 'PROJ-43' }, { status: 201 }))

    const ref = await create({ auth, title: 'Broken', bodyMarkdown: 'Details' })

    expect(ref).toEqual({
      externalId: 'PROJ-43',
      externalDisplayId: 'PROJ-43',
      externalUrl: 'https://tracker.example.com/acme/issue/PROJ-43',
    })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://api.example.com/projects/acme.PROJ/issues')
    expect(init.headers['x-api-key']).toBe('key')
    expect(JSON.parse(init.body)).toEqual({
      columnId: 1,
      title: 'Broken',
      description: 'Details',
      typeId: 7,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('applies the configured type and priority', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(setup))
      .mockResolvedValueOnce(Response.json({ id: 9, identifier: 'PROJ-43' }, { status: 201 }))

    await create({
      auth: { ...auth, issueTypeId: '8', issuePriority: 'medium' },
      title: 'Broken',
      bodyMarkdown: '',
    })

    const body = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(body.typeId).toBe(8)
    expect(body.priority).toBe('medium')
  })

  it('ignores a priority Parsec does not know', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(setup))
      .mockResolvedValueOnce(Response.json({ id: 9, identifier: 'PROJ-43' }, { status: 201 }))

    await create({ auth: { ...auth, issuePriority: 'none' }, title: 'x', bodyMarkdown: '' })

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).priority).toBeUndefined()
  })

  it('subscribes the watcher, then comments so Parsec notifies them', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(setup))
      .mockResolvedValueOnce(Response.json({ id: 9, identifier: 'PROJ-43' }, { status: 201 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({}, { status: 201 }))

    await create({ auth: { ...auth, watcherUserId: 'user-1' }, title: 'x', bodyMarkdown: '' })

    const [watchUrl, watchInit] = fetchMock.mock.calls[2]
    expect(watchUrl).toBe('https://api.example.com/issues/9/watchers/user-1')
    expect(watchInit.method).toBe('PUT')
    expect(fetchMock.mock.calls[3][0]).toBe('https://api.example.com/issues/9/comments')
  })

  it('keeps the created issue when subscribing the watcher fails', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(setup))
      .mockResolvedValueOnce(Response.json({ id: 9, identifier: 'PROJ-43' }, { status: 201 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))

    const ref = await create({
      auth: { ...auth, watcherUserId: 'user-1' },
      title: 'x',
      bodyMarkdown: '',
    })

    expect(ref.externalId).toBe('PROJ-43')
    expect(fetchMock).toHaveBeenCalledTimes(3)
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
