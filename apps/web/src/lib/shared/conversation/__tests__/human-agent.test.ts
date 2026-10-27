import { describe, it, expect } from 'vitest'
import { lastHumanAgent } from '../human-agent'

const author = (principalId: string, displayName: string | null) => ({
  principalId: principalId as never,
  displayName,
  avatarUrl: null,
})

// The messenger header shows the assistant until a teammate replies, then the
// teammate. Only a visible human agent reply counts.
describe('lastHumanAgent', () => {
  it('is null while only the visitor and the assistant have spoken', () => {
    expect(
      lastHumanAgent([
        { senderType: 'visitor', isAssistant: false, author: author('principal_v', 'Visitor') },
        { senderType: 'agent', isAssistant: true, author: author('principal_ai', 'Assistant') },
      ])
    ).toBeNull()
  })

  it('returns the teammate who replied last', () => {
    expect(
      lastHumanAgent([
        { senderType: 'agent', isAssistant: false, author: author('principal_a', 'Alex') },
        { senderType: 'visitor', isAssistant: false, author: author('principal_v', 'Visitor') },
        { senderType: 'agent', isAssistant: false, author: author('principal_b', 'Blake') },
        { senderType: 'agent', isAssistant: true, author: author('principal_ai', 'Assistant') },
      ])
    ).toEqual({ principalId: 'principal_b', name: 'Blake', avatarUrl: null })
  })

  it('ignores internal notes and system events', () => {
    expect(
      lastHumanAgent([
        { senderType: 'agent', isAssistant: false, author: author('principal_a', 'Alex') },
        {
          senderType: 'agent',
          isAssistant: false,
          isInternal: true,
          author: author('principal_b', 'Blake'),
        },
        { senderType: 'system', isAssistant: false, author: null },
      ])
    ).toEqual({ principalId: 'principal_a', name: 'Alex', avatarUrl: null })
  })
})
