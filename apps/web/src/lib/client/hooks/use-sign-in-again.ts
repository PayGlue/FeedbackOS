/**
 * Ask the person to sign in again before a sensitive action, then resume it.
 *
 * A page calls `request(action)` when a server function answers with the
 * recent-sign-in refusal (`isRecentSignInRequired`), and renders
 * `<SignInAgainDialog {...dialog} />`. `action` is a short string the page can
 * resume from, such as `approve:<id>`. `onSignedIn(action)` runs once the
 * server confirms the same person signed in within the window:
 *
 * - straight away, when the sign-in finished in the dialog (password, emailed
 *   code, or the emailed link opened in another tab, noticed when this tab is
 *   back in front);
 * - on landing back on the page, after an identity provider. The page may
 *   still be loading then, so `onSignedIn` should be able to wait for what the
 *   action needs.
 *
 * A sign-in as anyone else resumes nothing: the dialog says so, and closing it
 * reloads the page as the account now signed in. Use one per page; the action
 * names what to resume.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSignInAgainOptionsFn } from '@/lib/server/functions/sign-in-again'
import { startOidcSignIn } from '@/lib/client/start-oidc-sign-in'
import {
  readSignInAgainMarker,
  signInAgainProviderRequest,
  signInAgainReturnUrl,
  stashSignInAgain,
  takeSignInAgain,
  withoutSignInAgainMarker,
} from '@/lib/client/sign-in-again'
import type { SignInAgainOptions, SignInAgainProvider } from '@/lib/shared/sign-in-again'

/** Why the dialog shows something other than the sign-in. */
export type SignInAgainNotice = 'failed' | 'differentAccount'

export interface SignInAgainDialogProps {
  open: boolean
  /** How the person signs in; undefined while it loads. */
  options: SignInAgainOptions | undefined
  notice: SignInAgainNotice | null
  /** This page, marked with the action, for sign-ins that come back by link. */
  returnUrl: string
  onOpenChange: (open: boolean) => void
  /** A sign-in may have finished; confirms with the server and resumes. */
  onSignInFinished: () => void
  /** Leaves for an identity provider; false when the sign-in could not start. */
  onProvider: (provider: SignInAgainProvider) => Promise<boolean>
}

export interface UseSignInAgainResult {
  request: (action: string) => void
  dialog: SignInAgainDialogProps
}

const OPTIONS_KEY = ['auth', 'sign-in-again'] as const

export function useSignInAgain(options: {
  onSignedIn: (action: string) => void
}): UseSignInAgainResult {
  const queryClient = useQueryClient()
  const [action, setAction] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<SignInAgainNotice | null>(null)
  // The person who asked. Captured once per request, so a later read that
  // shows someone else is recognised as someone else.
  const askedByRef = useRef<string | null>(null)
  const reloadOnCloseRef = useRef(false)
  const landedRef = useRef(false)
  const onSignedInRef = useRef(options.onSignedIn)
  useEffect(() => {
    onSignedInRef.current = options.onSignedIn
  })

  const query = useQuery({
    queryKey: OPTIONS_KEY,
    queryFn: () => getSignInAgainOptionsFn(),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  useEffect(() => {
    if (open && query.data && askedByRef.current === null) askedByRef.current = query.data.userId
  }, [open, query.data])

  const readOptions = useCallback(
    () =>
      queryClient.fetchQuery({
        queryKey: OPTIONS_KEY,
        queryFn: () => getSignInAgainOptionsFn(),
        staleTime: 0,
      }),
    [queryClient]
  )

  const reopen = useCallback((pending: string, why: SignInAgainNotice) => {
    setAction(pending)
    setNotice(why)
    setOpen(true)
  }, [])

  const request = useCallback((next: string) => {
    askedByRef.current = null
    reloadOnCloseRef.current = false
    setAction(next)
    setNotice(null)
    setOpen(true)
  }, [])

  const onSignInFinished = useCallback(async () => {
    const pending = action
    if (!pending) return
    let current: SignInAgainOptions
    try {
      current = await readOptions()
    } catch {
      return
    }
    const askedBy = askedByRef.current
    if (askedBy && current.userId !== askedBy) {
      reloadOnCloseRef.current = true
      setNotice('differentAccount')
      return
    }
    if (!current.fresh) return
    setOpen(false)
    setAction(null)
    setNotice(null)
    onSignedInRef.current(pending)
  }, [action, readOptions])

  const onProvider = useCallback(
    async (provider: SignInAgainProvider) => {
      const person = query.data
      if (!action || !person) return false
      const returnUrl = signInAgainReturnUrl(window.location.href, action)
      stashSignInAgain({ action, userId: person.userId })
      try {
        const result = await startOidcSignIn(
          signInAgainProviderRequest(provider, person.email, returnUrl)
        )
        if (!result?.error) return true
      } catch {
        // Reported below, as a sign-in that did not start.
      }
      takeSignInAgain(action)
      return false
    },
    [action, query.data]
  )

  const onOpenChange = useCallback((next: boolean) => {
    if (next) {
      setOpen(true)
      return
    }
    setOpen(false)
    setAction(null)
    setNotice(null)
    if (reloadOnCloseRef.current) {
      reloadOnCloseRef.current = false
      window.location.assign(withoutSignInAgainMarker(window.location.href))
    }
  }, [])

  const signInFinished = useCallback(() => void onSignInFinished(), [onSignInFinished])

  // Landing back on the page after an identity provider.
  useEffect(() => {
    if (landedRef.current) return
    landedRef.current = true
    const marker = readSignInAgainMarker(window.location.href)
    if (!marker) return
    window.history.replaceState(
      window.history.state,
      '',
      withoutSignInAgainMarker(window.location.href)
    )
    const stash = takeSignInAgain(marker.action)
    if (!stash) return
    askedByRef.current = stash.userId
    if (marker.error) {
      reopen(stash.action, 'failed')
      return
    }
    readOptions().then(
      (current) => {
        if (current.userId !== stash.userId) reopen(stash.action, 'differentAccount')
        else if (current.fresh) onSignedInRef.current(stash.action)
        else reopen(stash.action, 'failed')
      },
      () => reopen(stash.action, 'failed')
    )
  }, [readOptions, reopen])

  return {
    request,
    dialog: {
      open,
      options: query.data,
      notice,
      returnUrl: action && open ? signInAgainReturnUrl(window.location.href, action) : '',
      onOpenChange,
      onSignInFinished: signInFinished,
      onProvider,
    },
  }
}
