/**
 * Call a server function the way the browser does, end to end.
 *
 * The build splits every `createServerFn(...).handler(impl)` in two: the
 * browser keeps `.handler(createClientRpc(id))`, which posts to
 * `/_serverFn/<id>`, and the server keeps
 * `.handler(createServerRpc(meta, ...), impl)`, which the Start request
 * handler looks up by id. `define` builds both halves the same way, and `call`
 * runs the browser half with its fetch pointed at the real
 * `createStartHandler`, so a result crosses the real request middleware
 * (`start.ts`: request context, workspace, CSRF), the real function middleware,
 * the real serializer and the real client fetcher before the test sees it.
 *
 * The Start handler finds server functions and the app's start instance
 * through package-internal imports the Vite plugin normally provides. Outside
 * a build those resolve to empty stand-ins, so this module registers Node
 * resolve hooks that point them at this harness, and sets the server-function
 * base path the handler reads as it loads. Import it before anything loads
 * `@tanstack/react-start/server`.
 */
import { register } from 'node:module'
import { vi } from 'vitest'

interface HarnessGlobals {
  __qbRpcServerFns?: Record<string, unknown>
  __qbRpcStartInstance?: unknown
}

const globals = globalThis as typeof globalThis & HarnessGlobals
globals.__qbRpcServerFns ??= {}

const moduleSource = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`

const RESOLVE_HOOKS = `
const stand_ins = {
  '#tanstack-start-server-fn-resolver': ${JSON.stringify(
    moduleSource(
      'export async function getServerFnById(id) { return globalThis.__qbRpcServerFns[id] }'
    )
  )},
  '#tanstack-start-entry': ${JSON.stringify(
    moduleSource('export const startInstance = globalThis.__qbRpcStartInstance')
  )},
  '#tanstack-router-entry': ${JSON.stringify(
    moduleSource(
      'export function getRouter() { throw new Error("server functions do not render a route") }'
    )
  )},
}
export async function resolve(specifier, context, next) {
  const url = stand_ins[specifier]
  return url ? { url, shortCircuit: true } : next(specifier, context)
}
`
register(moduleSource(RESOLVE_HOOKS))

// The Start handler reads the server-function base path once, as it loads.
process.env.TSS_SERVER_FN_BASE ??= '/_serverFn/'

const ORIGIN = 'http://localhost'
const START_CONTEXT = Symbol.for('tanstack-start:start-storage-context')

type Method = 'GET' | 'POST'
type ClientFn = (opts?: { data?: unknown }) => Promise<unknown>

export interface ServerFnDefinition<TData, TResult> {
  /** The id the build would derive from the file and export name. */
  id: string
  method: Method
  /** A schema or validator function, as `.validator()` takes. */
  validator?: unknown
  handler: (ctx: { data: TData }) => Promise<TResult>
}

export interface ServerFnRpc {
  define<TData, TResult>(
    definition: ServerFnDefinition<TData, TResult>
  ): (opts?: { data?: TData }) => Promise<TResult>
}

/** Starts the app's real Start handler and returns a way to define and call server functions. */
export async function createServerFnRpc(): Promise<ServerFnRpc> {
  // The workspace middleware reads the app config, which needs these.
  vi.stubEnv('BASE_URL', ORIGIN)
  vi.stubEnv('SECRET_KEY', 'test-secret-key-for-the-server-fn-harness-0001')

  const { createServerFn } = await import('@tanstack/react-start')
  const { createServerRpc } = await import('@tanstack/react-start/server-rpc')
  const { createClientRpc } = await import('@tanstack/react-start/client-rpc')
  const { createStartHandler, defaultStreamHandler } = await import('@tanstack/react-start/server')
  const { startInstance } = await import('@/start')

  globals.__qbRpcStartInstance = startInstance
  const startOptions = await startInstance.getOptions()
  const handleRequest = createStartHandler(defaultStreamHandler)

  /** The network: a same-origin browser request to the Start handler. */
  const browserFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('origin', ORIGIN)
    headers.set('sec-fetch-site', 'same-origin')
    return handleRequest(new Request(new URL(String(url), ORIGIN), { ...init, headers }))
  }

  const storage = (globalThis as unknown as Record<symbol, unknown>)[START_CONTEXT] as {
    run<T>(context: unknown, fn: () => T): T
  }

  /** What the browser's start instance holds: the same options, with fetch routed here. */
  const browserContext = {
    startOptions: { ...startOptions, serverFns: { fetch: browserFetch } },
    request: new Request(`${ORIGIN}/`),
    contextAfterGlobalMiddlewares: {},
    executedRequestMiddlewares: new Set(),
    handlerType: 'router',
  }

  return {
    define<TData, TResult>(definition: ServerFnDefinition<TData, TResult>) {
      const meta = { id: definition.id, name: definition.id, filename: 'harness.ts' }
      // `.handler()` as the build calls it, with the arguments the split passes.
      const splitHandler = () => {
        const fn = createServerFn({ method: definition.method })
        const built = definition.validator ? fn.validator(definition.validator as never) : fn
        return built.handler as unknown as (...args: unknown[]) => unknown
      }

      // Server half: the handler the Start handler resolves by id.
      type ServerHalf = { __executeServer: (opts: unknown) => Promise<unknown> }
      let serverHalf: ServerHalf | undefined = undefined
      const serverEntry = createServerRpc(meta, (opts: unknown) =>
        (serverHalf as ServerHalf).__executeServer(opts)
      )
      serverHalf = splitHandler()(serverEntry, definition.handler) as ServerHalf
      globals.__qbRpcServerFns![definition.id] = serverEntry

      // Browser half: posts to /_serverFn/<id> and reads the response back.
      const clientHalf = splitHandler()(createClientRpc(definition.id)) as ClientFn

      return (opts?: { data?: TData }) =>
        storage.run(browserContext, () => clientHalf(opts)) as Promise<TResult>
    },
  }
}
