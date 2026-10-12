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
  // The action waiting on a sign-in. A check claims it (clears this) before it
  // awaits anything, so the several signals one sign-in sends (the tab coming
  // back, its focus, the sign-in broadcast) resume it once at most.
  const pendingRef = useRef<string | null>(null)
  // Bumped by each request and each close, so a check that outlives either
  // neither resumes nor restores what it claimed.
  const generationRef = useRef(0)
  const checkingRef = useRef(false)
  const recheckRef = useRef(false)
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

  /**
   * Confirms the sign-in with the server and resumes the pending action at
   * most once. A signal that arrives while a check is out asks for one more
   * check rather than running its own. Until the server sees a fresh sign-in
   * the action stays pending; after an identity provider there is nothing
   * more to wait for, so the dialog opens again instead.
   */
  const confirm = useCallback(
    async (afterProvider = false): Promise<void> => {
      if (checkingRef.current) {
        recheckRef.current = true
        return
      }
      const pending = pendingRef.current
      if (!pending) return
      pendingRef.current = null
      const generation = generationRef.current
      checkingRef.current = true
      let outcome: 'resume' | 'differentAccount' | 'wait' = 'wait'
      try {
        const current = await readOptions()
        const askedBy = askedByRef.current
        if (askedBy && current.userId !== askedBy) outcome = 'differentAccount'
        else if (askedBy && current.fresh) outcome = 'resume'
      } catch {
        // Unconfirmed: keep waiting.
      } finally {
        checkingRef.current = false
      }
      if (generation !== generationRef.current) return

      if (outcome === 'resume') {
        recheckRef.current = false
        setOpen(false)
        setAction(null)
        setNotice(null)
        onSignedInRef.current(pending)
        return
      }
      if (outcome === 'differentAccount') {
        recheckRef.current = false
        reloadOnCloseRef.current = !afterProvider
        reopen(pending, 'differentAccount')
        return
      }
      pendingRef.current = pending
      if (afterProvider) {
        reopen(pending, 'failed')
        return
      }
      if (recheckRef.current) {
        recheckRef.current = false
        void confirm()
      }
    },
    [readOptions, reopen]
  )

  const request = useCallback((next: string) => {
    generationRef.current += 1
    pendingRef.current = next
    askedByRef.current = null
    reloadOnCloseRef.current = false
    setAction(next)
    setNotice(null)
    setOpen(true)
  }, [])

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
    generationRef.current += 1
    pendingRef.current = null
    setOpen(false)
    setAction(null)
    setNotice(null)
    if (reloadOnCloseRef.current) {
      reloadOnCloseRef.current = false
      window.location.assign(withoutSignInAgainMarker(window.location.href))
    }
  }, [])

  const signInFinished = useCallback(() => void confirm(), [confirm])

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
    generationRef.current += 1
    askedByRef.current = stash.userId
    if (marker.error) {
      pendingRef.current = stash.action
      reopen(stash.action, 'failed')
      return
    }
    pendingRef.current = stash.action
    void confirm(true)
  }, [confirm, reopen])

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
