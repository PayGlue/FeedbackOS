/**
 * Global request middleware: the request boundary for audit attribution.
 *
 * A server function is the signed-in app, so its changes are attributed to the
 * `ui` channel. Every other request opens an empty slot instead: REST key auth
 * runs inside the route handler and fills it with the key (see
 * domains/api/auth.ts), and the MCP handler and the assistant open their own
 * nested boundaries. Requests nothing attributes leave the columns null.
 *
 * A REST write the key made is recorded here once, as `api.write`, after the
 * route answers (see audit/api-write.ts). Reads are never recorded.
 *
 * Runs after workspace resolution so that anything recorded here lands in the
 * request's own workspace database.
 */
import { createMiddleware } from '@tanstack/react-start'
import { runWithAuditAttribution, UI_ATTRIBUTION } from '@/lib/server/audit/attribution'
import { isApiWrite, recordApiWrite } from '@/lib/server/audit/api-write'

interface NextResult {
  response?: Response
}

/** Core handling, decoupled from the framework so it can be unit tested. */
export async function handleRequestWithAuditAttribution<T extends NextResult>({
  request,
  handlerType,
  next,
}: {
  request: Request
  handlerType: 'serverFn' | 'router'
  next: () => Promise<T>
}): Promise<T> {
  return runWithAuditAttribution(handlerType === 'serverFn' ? UI_ATTRIBUTION : null, async () => {
    if (handlerType === 'serverFn' || !isApiWrite(request)) return next()

    let result: T
    try {
      result = await next()
    } catch (error) {
      await recordApiWrite(request, null)
      throw error
    }
    // A route always answers with a response; without one there is no outcome
    // to record.
    if (result.response) await recordApiWrite(request, result.response)
    return result
  })
}

export const auditAttributionMiddleware = createMiddleware().server(
  ({ next, request, handlerType }) =>
    handleRequestWithAuditAttribution({
      request,
      handlerType,
      next: () => Promise.resolve(next()),
    })
)
