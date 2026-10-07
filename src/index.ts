interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * OWID MCP — Our World in Data chart/indicator access (free, no auth)
 *
 * Every chart at ourworldindata.org/grapher/<slug> exposes its data as both CSV
 * and JSON metadata. This pack curates a list of high-signal indicators and lets
 * agents fetch any indicator by slug.
 *
 * This header used to say OWID has no public full-text search endpoint. It does
 * — ourworldindata.org/api/search, undocumented but stable, returning chart
 * slugs for a plain-language query. That mistaken note is why the pack shipped
 * with slug-guessing as the only discovery path for two years. It is now used on
 * the 404 path to suggest the slug the caller meant (see suggestSlugs).
 *
 * Tools:
 * - list_popular_indicators: curated catalog grouped by category
 * - fetch_indicator: tidy long-format data for one indicator, optional country filter
 * - get_indicator_metadata: title, description, units, source, last updated
 */


// Bound the fetch() calls in this pack that pass no signal of their own — a
// file with one guarded call still reads as "guarded" to the file-level grep
// while its other call sites hang unbounded (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'OWID');
}

const GRAPHER_BASE = 'https://ourworldindata.org/grapher';
// Only used on the 404 path, to turn a wrong slug into the right one.
const SEARCH_URL = 'https://ourworldindata.org/api/search';

interface IndicatorRef {
  slug: string;
  title: string;
  category: string;
}

// Every slug here is a promise: list_popular_indicators tells the caller to
// take it straight to fetch_indicator. Nine of the original forty broke that
// promise — seven had been renamed upstream and 404'd, and two returned
// metadata but were licensed against redistribution so the CSV could never be
// fetched. A user reported one of them; the other eight were found auditing the
// rest. Every slug below was verified live against BOTH url shapes
// (.metadata.json and .csv) on 2026-08-03. If you add a row, probe both first —
// a metadata-only check passes the licensed ones and misses the real failure.
const POPULAR: IndicatorRef[] = [
  // Energy
  { slug: 'primary-energy-consumption-by-source', title: 'Energy consumption by source', category: 'energy' },
  { slug: 'electricity-generation', title: 'Electricity generation', category: 'energy' },
  { slug: 'share-electricity-renewables', title: 'Share of electricity from renewables', category: 'energy' },
  { slug: 'per-capita-energy-use', title: 'Energy use per person', category: 'energy' },
  { slug: 'global-primary-energy', title: 'Global primary energy by source', category: 'energy' },
  // Climate & emissions
  { slug: 'co-emissions-per-capita', title: 'CO₂ emissions per capita', category: 'climate' },
  { slug: 'annual-co2-emissions-per-country', title: 'Annual CO₂ emissions by country', category: 'climate' },
  { slug: 'cumulative-co-emissions', title: 'Cumulative CO₂ emissions', category: 'climate' },
  { slug: 'methane-emissions', title: 'Methane emissions', category: 'climate' },
  { slug: 'temperature-anomaly', title: 'Global mean surface temperature anomaly', category: 'climate' },
  { slug: 'sea-surface-temperature-anomaly', title: 'Sea surface temperature anomaly', category: 'climate' },
  // Health
  { slug: 'life-expectancy', title: 'Life expectancy at birth', category: 'health' },
  { slug: 'child-mortality', title: 'Child mortality rate', category: 'health' },
  { slug: 'maternal-mortality', title: 'Maternal mortality ratio', category: 'health' },
  // 'share-of-deaths-by-cause' removed: IHME GBD data, non-redistributable, so
  // the CSV 403s permanently. annual-number-of-deaths-by-cause is blocked too.
  { slug: 'share-of-adults-who-smoke', title: 'Share of adults who smoke', category: 'health' },
  { slug: 'covid-vaccination-doses-per-capita', title: 'COVID-19 vaccine doses per capita', category: 'health' },
  // Demographics
  { slug: 'population', title: 'Population', category: 'demographics' },
  { slug: 'population-growth-rates', title: 'Population growth rate', category: 'demographics' },
  { slug: 'children-per-woman-un', title: 'Fertility rate (children per woman)', category: 'demographics' },
  { slug: 'urban-population-share-2050', title: 'Urban population share', category: 'demographics' },
  // Economy
  { slug: 'gdp-per-capita-worldbank', title: 'GDP per capita (World Bank)', category: 'economy' },
  { slug: 'gdp-per-capita-maddison-project-database', title: 'GDP per capita (Maddison)', category: 'economy' },
  { slug: 'share-of-population-in-extreme-poverty', title: 'Extreme poverty rate', category: 'economy' },
  { slug: 'unemployment-rate', title: 'Unemployment rate', category: 'economy' },
  // Not 'consumer-price-index' — that is the index level. This is the rate,
  // which is what the title promises.
  { slug: 'inflation-of-consumer-prices', title: 'Consumer price inflation', category: 'economy' },
  // Food & agriculture
  // 'global-food' removed: retired upstream with no successor chart.
  { slug: 'cereal-yield', title: 'Cereal yield', category: 'food' },
  { slug: 'prevalence-of-undernourishment', title: 'Share of population undernourished', category: 'food' },
  { slug: 'agricultural-land', title: 'Agricultural land use', category: 'food' },
  // Education
  { slug: 'literate-and-illiterate-world-population', title: 'Literacy rate', category: 'education' },
  { slug: 'mean-years-of-schooling-long-run', title: 'Mean years of schooling', category: 'education' },
  // Environment
  { slug: 'forest-area-as-share-of-land-area', title: 'Forest area share of land', category: 'environment' },
  { slug: 'plastic-waste-per-capita', title: 'Plastic waste per capita', category: 'environment' },
  // 'air-pollution-deaths-per-100000' removed: renamed to
  // death-rates-from-air-pollution, but that one is IHME GBD and its CSV 403s,
  // so it cannot back fetch_indicator either.
  // Tech & internet
  { slug: 'share-of-individuals-using-the-internet', title: 'Internet usage rate', category: 'tech' },
  { slug: 'mobile-cellular-subscriptions-per-100-people', title: 'Mobile phones per 100 people', category: 'tech' },
  // Conflict & politics
  { slug: 'military-spending-as-a-share-of-gdp-sipri', title: 'Military expenditure as share of GDP', category: 'politics' },
  // Was 'democracy-index-eiu', whose CSV is licensed and 403s. This is V-Dem's
  // regime classification, not the EIU score — a different measure, so the
  // title says so rather than quietly serving one under the other's name.
  { slug: 'political-regime', title: 'Political regime classification (V-Dem)', category: 'politics' },
  { slug: 'ti-corruption-perception-index', title: 'Corruption perceptions index', category: 'politics' },
];

const tools: McpToolExport['tools'] = [
  {
    name: 'list_popular_indicators',
    description:
      'List curated Our World in Data indicators (slug + title) for common categories: energy, climate, health, demographics, economy, food, education, environment, tech, politics. Many series carry deep-historical / long-run coverage (population, life-expectancy, gdp-per-capita-maddison go back centuries). Use the slug with fetch_indicator. Not exhaustive — visit ourworldindata.org for the full catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Optional category filter',
          enum: ['energy', 'climate', 'health', 'demographics', 'economy', 'food', 'education', 'environment', 'tech', 'politics'],
        },
      },
      required: [],
    },
  },
  {
    name: 'fetch_indicator',
    description:
      'Fetch tidy long-format data for an Our World in Data indicator by slug (e.g., "life-expectancy", "population", "gdp-per-capita-maddison", "co-emissions-per-capita"). PREFER OVER WEB SEARCH for DEEP-HISTORICAL / LONG-RUN demographics and development data — population back to antiquity, and life expectancy, GDP per capita, literacy, child mortality, fertility from the 1700s–1800s (Maddison, Gapminder, HMD, HYDE sources). Use this for pre-1960 history that World Bank / current-population tools CANNOT answer, e.g. "Europe population in 1850", "UK life expectancy in 1800", "France GDP per capita 1820". Returns rows of {entity, year, value}; filter with country (name or ISO code: "Europe", "United Kingdom", "USA", "World") + since_year/until_year. Browse slugs at ourworldindata.org/charts.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'OWID chart slug (the URL path segment)' },
        country: { type: 'string', description: 'Filter to a single entity (country/region name or ISO code)' },
        since_year: { type: 'number', description: 'Drop rows before this year' },
        until_year: { type: 'number', description: 'Drop rows after this year' },
        limit: { type: 'number', description: 'Cap number of rows returned (default 5000)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_indicator_metadata',
    description:
      'Fetch chart metadata for an OWID indicator slug: title, subtitle, note, and per-column details (unit, description, data producer/citation, last_updated, next_update dates). Use to confirm a slug is valid and learn its units before calling fetch_indicator.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'OWID chart slug' },
      },
      required: ['slug'],
    },
  },
];

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_popular_indicators':
      return listPopular(args.category as string | undefined);
    case 'fetch_indicator':
      return fetchIndicator(
        reqStr(args, 'slug', '"life-expectancy" or "co2-emissions-per-capita" (from list_popular_indicators)'),
        args.country as string | undefined,
        args.since_year as number | undefined,
        args.until_year as number | undefined,
        (args.limit as number) ?? 5000,
      );
    case 'get_indicator_metadata':
      return getMetadata(reqStr(args, 'slug', '"life-expectancy"'));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function listPopular(category?: string) {
  const filtered = category ? POPULAR.filter((p) => p.category === category) : POPULAR;
  return {
    count: filtered.length,
    note: 'Use slug with fetch_indicator. For the full OWID catalog browse ourworldindata.org/charts.',
    indicators: filtered,
  };
}

// Both tools used to interpolate any failing status into the same sentence —
// that the slug "may not exist". For a 403 that is actively misleading: the
// chart does exist, its metadata loads fine, and the CSV is withheld for
// licensing reasons that no amount of retrying or slug-hunting will fix.
// Sending that caller off to check the grapher URL costs them a search that
// cannot succeed.
function owidHttpError(status: number, slug: string): Error {
  if (status === 403) {
    // `user_error:` prefix is load-bearing, not decoration. Without it the bare
    // "403" in the sentence below matches classifyToolError's throttle rule and
    // this books as `upstream_throttled` — telling triage a permanent licensing
    // wall is a transient rate limit, and telling ask_pipeworx's retry loop it
    // is worth fanning out to sibling packs. It is neither. `user_error` is the
    // class that means "deterministic, the same args will not succeed
    // elsewhere", which is exactly true here. Same precedent as bundlephobia's
    // UnsupportedPackageError 403 and data.gov.sg's, both named in error-class.ts.
    return new Error(
      `user_error: OWID: the "${slug}" chart exists but its data is not redistributable, so it cannot be ` +
        `downloaded (HTTP 403). This is a licensing restriction on the underlying source — ` +
        `usually IHME Global Burden of Disease or the EIU democracy index — and it is permanent, ` +
        `so retrying or trying a variant slug will not help. Read it at ` +
        `ourworldindata.org/grapher/${slug}, or call list_popular_indicators for series that can be fetched.`,
    );
  }
  if (status === 404) {
    // A 404 on a slug we ourselves advertise is our bug, and it stays a plain
    // error so it keeps showing up in the daily error report — that signal is
    // what surfaced this whole class. A 404 on a slug the caller invented is a
    // caller mistake, and `user_error:` books it honestly instead of against us.
    const advertised = POPULAR.some((p) => p.slug === slug);
    if (advertised) {
      return new Error(
        `OWID error: 404 for "${slug}", which list_popular_indicators advertises — the chart was ` +
          `renamed or retired upstream and our curated list is stale. Please report it via ` +
          `pipeworx_feedback so we can repoint it.`,
      );
    }
    return new Error(
      `user_error: OWID has no chart with the slug "${slug}". Slugs are the last path segment of ` +
        `an ourworldindata.org/grapher/... URL, e.g. "life-expectancy". Call ` +
        `list_popular_indicators to see curated slugs, or browse ourworldindata.org/charts.`,
    );
  }
  return new Error(`OWID error: ${status} while fetching "${slug}"`);
}

// A 404 used to be a dead end, and callers responded the way you'd expect: one
// external agent burned ten calls in two hours guessing slugs — inflation-cpi,
// gdp-per-capita-current-usd, sex-ratio, international-migrant-stock-total,
// share-population-male-female — never landing one. Every guess was a correct
// DESCRIPTION of a chart OWID really publishes, under a name it doesn't use.
// Telling that agent to "call list_popular_indicators" doesn't help: that list
// is forty curated slugs and OWID has thousands of charts, so what it wants is
// usually not in there.
//
// OWID has a public search endpoint that maps exactly that description onto the
// real slug ("gdp per capita" -> gdp-per-capita-worldbank), so the 404 now spends
// one request to say "did you mean". Cheap because it only runs on the failure
// path, and it turns a loop of guesses into one working retry.
// Words that carry no search signal in a slug. `total`, `current` and `usd` are
// here because they are how callers qualify a measure ("gdp per capita CURRENT
// usd") and OWID puts that distinction in the slug's tail if at all — matching on
// them narrows the query to nothing. Bare years and numbers ("15-64") do the same.
const SLUG_STOPWORDS = new Set([
  'of', 'the', 'a', 'an', 'and', 'or', 'to', 'in', 'for', 'by', 'with', 'from',
  'total', 'current', 'usd', 'group', 'rate', 'all',
]);

async function searchCharts(query: string, exclude: string): Promise<string[]> {
  if (!query) return [];
  const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: { slug?: string; type?: string }[] };
  return (data.results ?? [])
    .filter((r) => r.type === 'chart' && typeof r.slug === 'string' && r.slug !== exclude)
    .map((r) => r.slug as string)
    .slice(0, 5);
}

async function suggestSlugs(slug: string): Promise<string[]> {
  // The slug IS the caller's description, just hyphenated — that's what makes
  // this work. They wrote what they wanted, in words; only the format is wrong.
  const full = slug.replace(/[-_]+/g, ' ').trim();
  if (!full) return [];
  try {
    const hits = await searchCharts(full, slug);
    if (hits.length >= 3) return hits;

    // The whole slug can be too specific to match anything: OWID's search ANDs
    // terms, so the longer and more qualified the guess, the likelier it returns
    // one bad hit or none. Measured on the real guesses from the logs —
    // "inflation cpi" found a US-only price chart while plain "inflation" finds
    // inflation-of-consumer-prices, and "population of the working age group 15
    // 64 years" found nothing relevant while "population working age" is exact.
    // So drop the qualifiers and keep the head of the phrase, which is where the
    // subject lives.
    const words = full.split(/\s+/).filter((w) => !SLUG_STOPWORDS.has(w) && !/^\d+$/.test(w));
    const short = words.slice(0, Math.min(3, Math.max(1, Math.ceil(words.length / 2)))).join(' ');
    // Exactly one retry, never a ladder. This runs against a nonprofit's search
    // endpoint on an error path; two requests buys most of the accuracy and a
    // third would mostly buy them load.
    if (!short || short === full) return hits;
    const broader = await searchCharts(short, slug);
    return broader.length > hits.length ? broader : hits;
  } catch {
    // Suggestions are a bonus, never a dependency. If search is slow, down or
    // changes shape, the caller still gets the plain 404 they were always going
    // to get — a broken hint must not turn a clear error into a confusing one.
    return [];
  }
}

// Wraps owidHttpError to attach suggestions on the one status where they help.
// Kept separate so the pure function stays synchronous and unit-testable, and so
// the classification prefixes it sets are decided in exactly one place.
async function owidHttpErrorWithHints(status: number, slug: string): Promise<Error> {
  const err = owidHttpError(status, slug);
  if (status !== 404) return err;
  const hits = await suggestSlugs(slug);
  if (!hits.length) return err;
  // Phrasing differs by whose fault it was: if we advertised the slug the caller
  // is owed a way forward, if they invented it they just need the right name.
  const lead = POPULAR.some((p) => p.slug === slug) ? 'In the meantime, OWID' : 'OWID';
  return new Error(
    `${err.message} ${lead} does publish these, which look close: ${hits.join(', ')}. ` +
      `Retry with one of those as \`slug\`.`,
  );
}

async function fetchIndicator(
  slug: string,
  country: string | undefined,
  since: number | undefined,
  until: number | undefined,
  limit: number,
) {
  const url = `${GRAPHER_BASE}/${encodeURIComponent(slug)}.csv?v=1&csvType=full&useColumnShortNames=true`;
  const res = await pwFetch(url);
  if (!res.ok) throw await owidHttpErrorWithHints(res.status, slug);
  const csv = await res.text();
  const rows = parseCsv(csv);
  if (rows.length === 0) return { slug, count: 0, columns: [], rows: [] };

  const header = rows[0];
  const entityIdx = header.findIndex((h) => /^entity$/i.test(h));
  const yearIdx = header.findIndex((h) => /^year$/i.test(h));
  const valueCols = header
    .map((h, i) => ({ name: h, i }))
    .filter((c) => c.i !== entityIdx && c.i !== yearIdx && c.i !== header.findIndex((h2) => /^code$/i.test(h2)));

  const normCountry = country?.toLowerCase().trim();
  const out: Record<string, unknown>[] = [];
  for (let i = 1; i < rows.length && out.length < limit; i++) {
    const r = rows[i];
    const entity = entityIdx >= 0 ? r[entityIdx] : '';
    if (normCountry && entity.toLowerCase() !== normCountry) continue;
    const year = yearIdx >= 0 ? Number(r[yearIdx]) : NaN;
    if (since != null && year < since) continue;
    if (until != null && year > until) continue;

    const row: Record<string, unknown> = { entity, year: Number.isFinite(year) ? year : null };
    for (const c of valueCols) {
      const v = r[c.i];
      const num = v === '' || v == null ? null : Number(v);
      row[c.name] = Number.isFinite(num as number) ? num : v;
    }
    out.push(row);
  }

  return {
    slug,
    source_url: `https://ourworldindata.org/grapher/${slug}`,
    columns: ['entity', 'year', ...valueCols.map((c) => c.name)],
    count: out.length,
    rows: out,
    // Measured (fleet #2324): fetch_indicator is the #3 single-tool entry
    // point in 30d, 57 distinct external callers who never call anything
    // else. The rows here are bare numbers with no unit/source/citation —
    // get_indicator_metadata is the one call that answers "what am I
    // actually looking at", using the same slug this response resolved.
    //
    // 14d re-measure (fleet #2325, 2026-10-07, same 30d-window methodology —
    // SQL_REAL_EXTERNAL_CALL, blob6/blob1/blob2 grain, re-verified against
    // the #2324 baseline numbers above to within noise): single-tool-only
    // callers of fetch_indicator 57 -> 46 (total callers 65 -> 60), share
    // 87.7% -> 76.7%, DOWN 11.0pt. Window still blends ~16d pre-hint traffic
    // with the 14d post-hint period, and N is small — directional, not a
    // verdict. Full 8-tool + catalog-wide comparison in the fleet #2325 close.
    next: {
      tool: 'get_indicator_metadata',
      args: { slug },
      why: 'Units, source/citation and last-updated date for this indicator — not carried in the tidy data rows above.',
    },
  };
}

async function getMetadata(slug: string) {
  const url = `${GRAPHER_BASE}/${encodeURIComponent(slug)}.metadata.json?v=1`;
  const res = await pwFetch(url);
  if (!res.ok) throw await owidHttpErrorWithHints(res.status, slug);
  const meta = (await res.json()) as {
    chart?: { title?: string; subtitle?: string; note?: string };
    columns?: Record<
      string,
      {
        titleShort?: string;
        titleLong?: string;
        unit?: string;
        shortUnit?: string;
        descriptionShort?: string;
        descriptionFromProducer?: string;
        producerShort?: string;
        citationShort?: string;
        lastUpdated?: string;
        nextUpdate?: string;
      }
    >;
  };

  const cols = meta.columns ?? {};
  return {
    slug,
    source_url: `https://ourworldindata.org/grapher/${slug}`,
    title: meta.chart?.title ?? null,
    subtitle: meta.chart?.subtitle ?? null,
    note: meta.chart?.note ?? null,
    columns: Object.entries(cols).map(([key, c]) => ({
      key,
      title: c.titleLong ?? c.titleShort ?? key,
      unit: c.unit ?? c.shortUnit ?? null,
      description: c.descriptionShort ?? c.descriptionFromProducer ?? null,
      producer: c.producerShort ?? null,
      citation: c.citationShort ?? null,
      last_updated: c.lastUpdated ?? null,
      next_update: c.nextUpdate ?? null,
    })),
  };
}

// ── CSV parsing (minimal RFC-4180 subset OWID emits) ─────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (ch === '\r') {
        // skip; handled by \n
      } else {
        cell += ch;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
