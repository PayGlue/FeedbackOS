// @vitest-environment happy-dom
/**
 * Subscribing needs a signed-in principal. A visitor without one has to land
 * in the sign-in dialog rather than on a generic error, whichever of the two
 * refusals the server sends: one for an anonymous session, one for no session.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openAuthPopover = vi.fn()
const subscribeStatusFn = vi.fn()
const toastError = vi.fn()

vi.mock('@/components/auth/auth-popover-context', () => ({
  useAuthPopoverSafe: () => ({ openAuthPopover }),
}))
vi.mock('@/lib/server/functions/status-subscriptions', () => ({
  subscribeStatusFn: (...args: unknown[]) => subscribeStatusFn(...args),
  unsubscribeStatusFn: vi.fn(),
}))
vi.mock('@/lib/client/queries/status', () => ({
  publicStatusPageQueries: { get: () => ({ queryKey: ['status-page'], queryFn: () => null }) },
  publicStatusSubscriptionQueries: {
    mine: () => ({ queryKey: ['status-mine'], queryFn: () => null }),
  },
  statusKeys: { mySubscription: () => ['status-mine'] },
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}))

import { StatusSubscribeButton } from '../status-subscribe-button'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function submitWith(message: string) {
  subscribeStatusFn.mockRejectedValue(new Error(message))
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <IntlProvider locale="en" defaultLocale="en">
        <StatusSubscribeButton />
      </IntlProvider>
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
  const buttons = await screen.findAllByRole('button', { name: 'Subscribe' })
  fireEvent.click(buttons[buttons.length - 1])
}

describe('StatusSubscribeButton', () => {
  it.each(['Authentication required', 'Anonymous interaction is not enabled'])(
    'opens sign-in when the server answers %s',
    async (message) => {
      await submitWith(message)
      await waitFor(() => expect(openAuthPopover).toHaveBeenCalledWith({ mode: 'login' }))
      expect(toastError).not.toHaveBeenCalled()
    }
  )

  it('shows the error for any other failure', async () => {
    await submitWith('Database unavailable')
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(openAuthPopover).not.toHaveBeenCalled()
  })
})
