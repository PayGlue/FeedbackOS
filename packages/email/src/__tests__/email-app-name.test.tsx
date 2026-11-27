import { afterEach, describe, it, expect } from 'vitest'
import { render } from '@react-email/components'
import { MagicLinkEmail } from '../templates/magic-link'

describe('FeedbackOS: EMAIL_APP_NAME', () => {
  const previous = process.env.EMAIL_APP_NAME
  afterEach(() => {
    if (previous === undefined) delete process.env.EMAIL_APP_NAME
    else process.env.EMAIL_APP_NAME = previous
  })

  it('names the instance in the logo of sign-in emails', async () => {
    process.env.EMAIL_APP_NAME = 'PayGlue'
    const html = await render(<MagicLinkEmail signInUrl="https://x.example/v" code="123456" />)
    expect(html).toContain('PayGlue')
    expect(html).not.toContain('Quackback')
  })

  it('keeps the upstream name when it is not set', async () => {
    delete process.env.EMAIL_APP_NAME
    const html = await render(<MagicLinkEmail signInUrl="https://x.example/v" code="123456" />)
    expect(html).toContain('Quackback')
  })
})
