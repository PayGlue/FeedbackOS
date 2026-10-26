import { describe, it, expect } from 'vitest'
import { senderDisplayName } from '../conversation.email-cold-inbound'

describe('senderDisplayName', () => {
  it('reads a quoted or bare display name', () => {
    expect(senderDisplayName('"Jane Doe" <jane@acme.com>')).toBe('Jane Doe')
    expect(senderDisplayName('André Nünninghoff <andre@imap.cc>')).toBe('André Nünninghoff')
  })

  it('is null for a bare address or an empty header', () => {
    expect(senderDisplayName('nuenni@web.de')).toBeNull()
    expect(senderDisplayName('<nuenni@web.de>')).toBeNull()
    expect(senderDisplayName(null)).toBeNull()
  })
})
