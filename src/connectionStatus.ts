import type {
  ConnectionRejectionCause,
  PluginActionStatus,
  PluginConnectionVerdict,
  StatusAccessor,
} from '@omadia/plugin-api';

/**
 * byte5ai/omadia#1453 — connection health of the Confluence integration.
 *
 * Two writers feed the same `ctx.status` channel:
 *
 *  - the kernel, which calls the plugin's `verifyConnection` export after every
 *    activation and on the operator's "check now" (see `verdictFromProbe`);
 *  - the plugin itself, at call time, because the probe only runs on
 *    activation: a token revoked upstream while the plugin is up is first seen
 *    by a real request (see `CallTimeStatusReporter`).
 *
 * The rule both follow is core's: only an EXPLICIT authentication refusal
 * (HTTP 401, or a 403 whose body names authentication) means "bad
 * credentials". A 5xx, a timeout, a DNS failure, a redirect or a
 * captive-portal HTML page is "we don't know" and must not turn the plugin
 * red, because a red status also withholds the plugin's tools from the
 * orchestrator.
 *
 * No `title`/`detail` is reported: the plugin cannot see the operator's
 * locale, and the web-ui supplies its own localized copy for each state.
 *
 * Only TYPES are imported from `@omadia/plugin-api`, so this module loads on
 * hosts older than plugin-api 1.35.0 as well.
 */

/** The raw answer of the probe request — what `verdictFromProbe` classifies. */
export interface ProbeResponse {
  readonly status: number;
  readonly contentType: string;
  readonly bodyText: string;
}

export const INCONCLUSIVE: PluginConnectionVerdict = Object.freeze({
  status: 'inconclusive',
});

/** Body markers of a 403 that is an authentication refusal rather than a
 *  permission/plan/region refusal. Same list as core's helper. */
const AUTH_403_MARKERS = [
  'unauthenticated',
  'authentication',
  'invalid_token',
  'invalid api key',
  'invalid x-api-key',
] as const;

/**
 * Explicit auth refusal for one upstream exchange, or `undefined`.
 *
 * Local copy of core's `classifyHttpAuthFailure` (`@omadia/plugin-api` 1.35.0,
 * `pluginContext.ts`), inlined on purpose: an ESM named import of a runtime
 * export the host lacks fails the whole module at link time, which would stop
 * this plugin from loading on older hosts. Keep the two in step — a 401 is
 * always a refusal; a 403 only when its body names authentication itself (an
 * Atlassian 403 for a missing space/product permission is NOT one).
 */
export function authRejectionCause(
  status: number,
  bodyText: string | undefined,
): ConnectionRejectionCause | undefined {
  if (status === 401) return 'http_401';
  if (status !== 403) return undefined;
  const body = (bodyText ?? '').toLowerCase();
  return AUTH_403_MARKERS.some((marker) => body.includes(marker))
    ? 'http_403_auth'
    : undefined;
}

/**
 * Classify the answer of `GET /rest/api/user/current`.
 *
 *  - explicit auth refusal                       ⇒ `rejected` (with its cause)
 *  - 2xx JSON naming a real (non-anonymous) user ⇒ `connected`
 *  - everything else (non-2xx, HTML, unparseable JSON, anonymous user)
 *                                                ⇒ `inconclusive`
 *
 * A 2xx alone is not a pass: a captive portal or proxy login page answers 200
 * with HTML. An anonymous user is not a pass either (the site let us in
 * without accepting the token) — but it is not reported as a rejection,
 * because it is not an explicit refusal.
 */
export function verdictFromProbe(res: ProbeResponse): PluginConnectionVerdict {
  const cause = authRejectionCause(res.status, res.bodyText);
  if (cause) return { status: 'rejected', cause };
  if (res.status < 200 || res.status >= 300) return INCONCLUSIVE;
  if (!res.contentType.toLowerCase().includes('json')) return INCONCLUSIVE;
  return isAuthenticatedUser(res.bodyText) ? { status: 'connected' } : INCONCLUSIVE;
}

function isAuthenticatedUser(bodyText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const user = parsed as Record<string, unknown>;
  if (user['type'] === 'anonymous') return false;
  // Cloud answers `accountId`; Server/DC answer `username` / `userKey`.
  return ['accountId', 'username', 'userKey'].some(
    (key) => typeof user[key] === 'string' && (user[key] as string).length > 0,
  );
}

/**
 * What the client tells about each real upstream call. Implementations must
 * never throw into the request path.
 */
export interface ConnectionObserver {
  /** The target system explicitly refused the credentials. */
  authRejected(cause: ConnectionRejectionCause): void;
  /** A call succeeded with a usable answer. */
  succeeded(): void;
}

/**
 * Call-time reporter: a real request that is refused for auth reasons puts
 * the plugin into `error` right away (store badge + tool gate, no chat turn
 * needed to find out). A later successful call reports `ok` again — but only
 * if this reporter raised the error itself, so it never clears a status some
 * other writer set.
 *
 * Every rejection is re-reported (not only the first): the kernel's probe
 * writes through the same channel and may have cleared the status in
 * between, and the kernel re-stamps `checked_at` on each report.
 */
export class CallTimeStatusReporter implements ConnectionObserver {
  private raisedError = false;

  constructor(
    private readonly status: Pick<StatusAccessor, 'report'>,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  authRejected(_cause: ConnectionRejectionCause): void {
    this.write({ state: 'error' }, true);
  }

  succeeded(): void {
    if (!this.raisedError) return;
    this.write({ state: 'ok' }, false);
  }

  private write(status: PluginActionStatus, raisedError: boolean): void {
    try {
      this.status.report(status);
      this.raisedError = raisedError;
    } catch (err) {
      // Also covers hosts without `ctx.status` (older plugin-api).
      this.log(
        `[confluence] could not report status '${status.state}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
