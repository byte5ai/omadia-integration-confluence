import {
  classifyHttpAuthFailure,
  type ConnectionRejectionCause,
  type PluginActionStatus,
  type PluginConnectionVerdict,
  type StatusAccessor,
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
 * (HTTP 401, or a 403 whose body names authentication — decided by
 * `classifyHttpAuthFailure`, never by hand here) means "bad credentials".
 * A 5xx, a timeout, a DNS failure, a redirect or a captive-portal HTML page is
 * "we don't know" and must not turn the plugin red, because a red status also
 * withholds the plugin's tools from the orchestrator.
 *
 * The kernel ships no operator-facing copy, so the strings below are the
 * plugin's own. They are German like the rest of this plugin's manifest.
 */

/** Operator-facing copy for the status badge/banner. */
export const STATUS_COPY = {
  connectedTitle: 'Verbunden',
  rejectedTitle: 'Nicht verbunden',
  rejectedDetail: (cause: ConnectionRejectionCause): string =>
    `Confluence hat E-Mail/API-Token abgelehnt (${CAUSE_LABEL[cause]}). ` +
    'Zugangsdaten in den Setup-Feldern prüfen.',
} as const;

const CAUSE_LABEL: Readonly<Record<ConnectionRejectionCause, string>> = {
  http_401: 'HTTP 401',
  http_403_auth: 'HTTP 403',
  protocol_auth_failure: 'Anmeldung fehlgeschlagen',
};

/** The raw answer of the probe request — what `verdictFromProbe` classifies. */
export interface ProbeResponse {
  readonly status: number;
  readonly contentType: string;
  readonly bodyText: string;
}

export const INCONCLUSIVE: PluginConnectionVerdict = Object.freeze({
  status: 'inconclusive',
});

/**
 * Explicit auth refusal for one upstream exchange, or `undefined`. Thin seam
 * over core's helper so the client and the probe share one decision.
 */
export function authRejectionCause(
  status: number,
  bodyText: string | undefined,
): ConnectionRejectionCause | undefined {
  return classifyHttpAuthFailure(status, bodyText);
}

/**
 * Classify the answer of `GET /rest/api/user/current`.
 *
 *  - explicit auth refusal                     ⇒ `rejected` (with its cause)
 *  - 2xx JSON naming a real (non-anonymous) user ⇒ `connected`
 *  - everything else (non-2xx, HTML, unparseable JSON, anonymous user)
 *                                              ⇒ `inconclusive`
 *
 * A 2xx alone is not a pass: a captive portal or proxy login page answers 200
 * with HTML. An anonymous user is not a pass either (the site let us in
 * without accepting the token) — but it is not reported as a rejection,
 * because it is not an explicit refusal.
 */
export function verdictFromProbe(res: ProbeResponse): PluginConnectionVerdict {
  const cause = authRejectionCause(res.status, res.bodyText);
  if (cause) {
    return {
      status: 'rejected',
      cause,
      title: STATUS_COPY.rejectedTitle,
      detail: STATUS_COPY.rejectedDetail(cause),
    };
  }
  if (res.status < 200 || res.status >= 300) return INCONCLUSIVE;
  if (!res.contentType.toLowerCase().includes('json')) return INCONCLUSIVE;
  return isAuthenticatedUser(res.bodyText)
    ? { status: 'connected', title: STATUS_COPY.connectedTitle }
    : INCONCLUSIVE;
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
 * writes through the same channel and may have reported `connected` in
 * between, and the kernel re-stamps `checked_at` on each report.
 */
export class CallTimeStatusReporter implements ConnectionObserver {
  private raisedError = false;

  constructor(
    private readonly status: Pick<StatusAccessor, 'report'>,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  authRejected(cause: ConnectionRejectionCause): void {
    this.write({
      state: 'error',
      title: STATUS_COPY.rejectedTitle,
      detail: STATUS_COPY.rejectedDetail(cause),
    }, true);
  }

  succeeded(): void {
    if (!this.raisedError) return;
    this.write({ state: 'ok', title: STATUS_COPY.connectedTitle }, false);
  }

  private write(status: PluginActionStatus, raisedError: boolean): void {
    try {
      this.status.report(status);
      this.raisedError = raisedError;
    } catch (err) {
      this.log(
        `[confluence] could not report status '${status.state}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
