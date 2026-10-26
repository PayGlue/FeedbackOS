import { describe, it, expect } from 'vitest'
import { senderDisplayName } from '../conversation.email-cold-inbound'

describe('senderDisplayName', () => {
  it('reads a quoted or bare display name', () => {
    expect(senderDisplayName('"Jane Doe" <jane@acme.com>')).toBe('Jane Doe')
    expect(senderDisplayName('Zoë Müller <zoe@example.org>')).toBe('Zoë Müller')
  })

  it('is null for a bare address or an empty header', () => {
    expect(senderDisplayName('sam@example.net')).toBeNull()
    expect(senderDisplayName('<sam@example.net>')).toBeNull()
    expect(senderDisplayName(null)).toBeNull()
  })
})
