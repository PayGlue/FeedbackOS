// @vitest-environment happy-dom
/**
 * Signing in again from a page: the dialog sends the person through their own
 * sign-in (their identity provider, or the ordinary form with their address
 * locked), and the page's action resumes only once the server confirms a fresh
 * sign-in by the same person, whether the sign-in finished in the dialog or
 * came back from a provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SignInAgainOptions } from '@/lib/shared/sign-in-again'

const hoisted = vi.hoisted(() => ({
  options: vi.fn(),
  startOidcSignIn: vi.fn(),
  signOut: vi.fn(),
  broadcast: { onSuccess: undefined as undefined | (() => void), enabled: false },
  formProps: null as null | Record<string, unknown>,
}))

vi.mock('@/lib/server/functions/sign-in-again', () => ({
  getSignInAgainOptionsFn: () => hoisted.options(),
}))
vi.mock('@/lib/client/start-oidc-sign-in', () => ({
  startOidcSignIn: (args: unknown) => hoisted.startOidcSignIn(args),
}))
vi.mock('@/lib/client/auth-client', () => ({ signOut: () => hoisted.signOut() }))
vi.mock('@/lib/client/hooks/use-auth-broadcast', () => ({
  useAuthBroadcast: (opts: { onSuccess?: () => void; enabled?: boolean }) => {
    hoisted.broadcast.onSuccess = opts.onSuccess
    hoisted.broadcast.enabled = opts.enabled ?? true
  },
}))
vi.mock('../portal-auth-form-inline', () => ({
  PortalAuthFormInline: (props: Record<string, unknown>) => {
    hoisted.formProps = props
    return <div>SIGN_IN_FORM</div>
  },
}))

const { useSignInAgain } = await import('@/lib/client/hooks/use-sign-in-again')
const { SignInAgainDialog } = await import('../sign-in-again-dialog')

const PAGE = '/admin/approvals?status=open'
const RETURN = '/admin/approvals?status=open&signedInAgain=approve%3Aact_1'
const STASH_KEY = 'quackback:sign-in-again'

const okta = { id: 'oidc_okta', name: 'Okta', type: 'oidc' as const }

function opts(overrides: Partial<SignInAgainOptions> = {}): SignInAgainOptions {
  return {
    userId: 'user_me',
    email: 'me@acme.com',
    fresh: false,
    providers: [],
    emailMethods: { password: true, magicLink: false, twoFactorRequired: false },
    ...overrides,
  }
}

function Page({ onSignedIn }: { onSignedIn: (action: string) => void }) {
  const signInAgain = useSignInAgain({ onSignedIn })
  return (
    <>
      <button type="button" onClick={() => signInAgain.request('approve:act_1')}>
        Approve
      </button>
      <SignInAgainDialog {...signInAgain.dialog} />
    </>
  )
}

function renderPage(onSignedIn = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <Page onSignedIn={onSignedIn} />
      </IntlProvider>
    </QueryClientProvider>
  )
  return onSignedIn
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.formProps = null
  hoisted.broadcast.onSuccess = undefined
  window.sessionStorage.clear()
  window.history.replaceState(null, '', PAGE)
})
afterEach(() => cleanup())

describe('asking to sign in again', () => {
  it('sends a person whose workspace enforces SSO through their provider, back to this page', async () => {
    hoisted.options.mockResolvedValue(opts({ providers: [okta], emailMethods: null }))
    hoisted.startOidcSignIn.mockResolvedValue({ data: { url: 'https://idp.example/authorize' } })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('Sign in again')).toBeInTheDocument()
    expect(
      screen.getByText('For your security, sign in again to approve this change.')
    ).toBeInTheDocument()
    expect(screen.queryByText('SIGN_IN_FORM')).not.toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Okta' }))
    await waitFor(() => expect(hoisted.startOidcSignIn).toHaveBeenCalledTimes(1))
    const request = hoisted.startOidcSignIn.mock.calls[0][0]
    expect(request).toEqual({
      providerId: 'oidc_okta',
      callbackURL: RETURN,
      errorCallbackURL: RETURN,
      loginHint: 'me@acme.com',
    })
    expect(JSON.stringify(request)).not.toMatch(/prompt|max_age|select_account/)
    expect(JSON.parse(window.sessionStorage.getItem(STASH_KEY)!)).toMatchObject({
      action: 'approve:act_1',
      userId: 'user_me',
    })
  })

  it("locks the person's own address in the sign-in form for an email account", async () => {
    hoisted.options.mockResolvedValue(opts())
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('SIGN_IN_FORM')).toBeInTheDocument()
    expect(hoisted.formProps).toMatchObject({
      mode: 'login',
      lockedEmail: 'me@acme.com',
      callbackUrl: RETURN,
      authConfig: {
        found: true,
        oauth: { password: true, magicLink: false },
        twoFactorRequired: false,
      },
    })
    expect(screen.queryByRole('button', { name: /sign in with/i })).not.toBeInTheDocument()
  })

  it('resumes the action once the server confirms a fresh sign-in by the same person', async () => {
    hoisted.options.mockResolvedValue(opts())
    const onSignedIn = renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('SIGN_IN_FORM')

    // A broadcast that arrives before the server sees a fresh sign-in resumes nothing.
    await act(async () => hoisted.broadcast.onSuccess?.())
    expect(onSignedIn).not.toHaveBeenCalled()

    hoisted.options.mockResolvedValue(opts({ fresh: true }))
    await act(async () => hoisted.broadcast.onSuccess?.())
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('approve:act_1'))
    await waitFor(() => expect(screen.queryByText('Sign in again')).not.toBeInTheDocument())
  })

  it('resumes nothing when a different account signed in', async () => {
    hoisted.options.mockResolvedValue(opts())
    const onSignedIn = renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('SIGN_IN_FORM')

    hoisted.options.mockResolvedValue(opts({ userId: 'user_other', fresh: true }))
    await act(async () => hoisted.broadcast.onSuccess?.())

    expect(
      await screen.findByText('You signed in with a different account, so nothing was changed.')
    ).toBeInTheDocument()
    expect(onSignedIn).not.toHaveBeenCalled()
  })
})

describe('coming back from an identity provider', () => {
  function landBack(search: string, stashedFor: string | null) {
    if (stashedFor) {
      window.sessionStorage.setItem(
        STASH_KEY,
        JSON.stringify({ action: 'approve:act_1', userId: stashedFor, startedAt: Date.now() })
      )
    }
    window.history.replaceState(null, '', `/admin/approvals?status=open&${search}`)
  }

  it('resumes the action for the same person, fresh, and clears the marker', async () => {
    landBack('signedInAgain=approve%3Aact_1', 'user_me')
    hoisted.options.mockResolvedValue(opts({ fresh: true }))
    const onSignedIn = renderPage()

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('approve:act_1'))
    expect(window.location.pathname + window.location.search).toBe(PAGE)
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull()
  })

  it('resumes nothing when the provider signed in a different account', async () => {
    landBack('signedInAgain=approve%3Aact_1', 'user_me')
    hoisted.options.mockResolvedValue(opts({ userId: 'user_other', fresh: true }))
    const onSignedIn = renderPage()

    expect(
      await screen.findByText('You signed in with a different account, so nothing was changed.')
    ).toBeInTheDocument()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('offers the sign-in again when the provider refused', async () => {
    landBack('signedInAgain=approve%3Aact_1&error=access_denied', 'user_me')
    hoisted.options.mockResolvedValue(opts({ providers: [okta], emailMethods: null }))
    const onSignedIn = renderPage()

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Sign in with Okta' })).toBeInTheDocument()
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?status=open')
  })

  it('does nothing in a tab that did not ask, such as one opened from the emailed link', async () => {
    landBack('signedInAgain=approve%3Aact_1', null)
    hoisted.options.mockResolvedValue(opts({ fresh: true }))
    const onSignedIn = renderPage()

    await waitFor(() => expect(window.location.search).toBe('?status=open'))
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(screen.queryByText('Sign in again')).not.toBeInTheDocument()
  })
})
