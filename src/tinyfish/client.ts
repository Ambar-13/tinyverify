/**
 * Thin typed client over TinyFish's HTTP APIs. No SDK: plain fetch with an X-API-Key header. Errors never carry the
 * request body or the API key.
 */

export type FetchResult = {
  url: string;
  final_url: string;
  title: string;
  description: string;
  language: string;
  format: string;
  text: string;
  author: string | null;
  published_date: string | null;
  latency_ms: number;
};

export type FetchError = { url: string; code: string; message: string };

export type RunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * One step of a run. has_html and has_screenshot say whether TinyFish captured that page; the closing
 * "Task completed" step has neither. Left out when the source did not say.
 */
export interface RunStep {
  step_id: string;
  has_html?: boolean;
  has_screenshot?: boolean;
}

export interface RunResult {
  run_id: string;
  status: RunStatus;
  result: unknown;
  steps: RunStep[];
  steps_used: number;
  error: {
    code: 'SYSTEM_FAILURE' | 'AGENT_FAILURE' | 'BILLING_FAILURE' | 'MAX_STEPS_EXCEEDED' | 'UNKNOWN' | string;
    message: string;
  } | null;
  streaming_url?: string | null;
}

/**
 * The fields of a run in TinyFish's reply that getRun reads. Only the fields are named; their values are not checked.
 */
interface RunPayload {
  run_id: string;
  status: RunStatus;
  result?: unknown;
  steps?: unknown;
  num_of_steps?: unknown;
  error?: { code: string; message: string } | null;
  streaming_url?: string | null;
}

export class TinyFishError extends Error {
  readonly code: string;
  readonly status: number;
  // Set on 429 responses when the Retry-After header is a number of seconds.
  retryAfterSeconds?: number;
  // The message TinyFish gave with an error status, cut to 300 characters. For logs only; it never reaches a caller.
  detail?: string;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'TinyFishError';
    this.code = code;
    this.status = status;
  }
}

const FETCH_URL = 'https://api.fetch.tinyfish.ai';
const SEARCH_URL = 'https://api.search.tinyfish.ai/';
const AGENT_URL = 'https://agent.tinyfish.ai';

const DEFAULT_TIMEOUT_MS = 20_000;
/** Monitor creation and manual runs fetch a page for their baseline, so they get longer. */
const LONG_TIMEOUT_MS = 90_000;

/** A response whose headers arrived, with the signal that bounds reading its body. */
type Sent = { res: Response; signal: AbortSignal; errorBody?: string };

export class TinyFish {
  readonly #apiKey: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs?: number;

  // timeoutMs overrides the per-call defaults (20 s, 90 s for monitor calls); tests use it.
  constructor(apiKey: string, fetchImpl: typeof fetch = fetch, opts: { timeoutMs?: number } = {}) {
    this.#apiKey = apiKey;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = opts.timeoutMs;
  }

  async fetchPages(
    urls: string[],
    opts?: { format?: 'html' | 'markdown'; ttl?: number },
  ): Promise<{ results: FetchResult[]; errors: FetchError[] }> {
    const sent = await this.send(FETCH_URL, {
      method: 'POST',
      body: { urls, format: opts?.format, ttl: opts?.ttl },
    });
    return this.json(sent);
  }

  async search(
    query: string,
    opts?: { location?: string; include_domains?: string },
  ): Promise<{ results: { position: number; title: string; url: string; snippet: string }[] }> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('query', query);
    if (opts?.location !== undefined) url.searchParams.set('location', opts.location);
    if (opts?.include_domains !== undefined) url.searchParams.set('include_domains', opts.include_domains);
    return this.json(await this.send(url.toString(), { method: 'GET' }));
  }

  async runAsync(req: {
    url: string;
    goal: string;
    output_schema?: object;
    browser_profile?: 'lite' | 'stealth';
    proxy_config?: { enabled: boolean; country_code?: string };
    agent_config?: { max_steps?: number; max_duration_seconds?: number };
    capture_config?: { html?: boolean; screenshots?: boolean };
    webhook_url?: string;
  }): Promise<{ run_id: string; streaming_url?: string }> {
    return this.json(await this.send(`${AGENT_URL}/v1/automation/run-async`, { method: 'POST', body: req }));
  }

  async getRun(id: string): Promise<RunResult> {
    const sent = await this.send(`${AGENT_URL}/v1/runs/${encodeURIComponent(id)}`, { method: 'GET' });
    // An empty reply body leaves every field undefined.
    const raw = (await this.json<RunPayload | null>(sent)) ?? ({} as RunPayload);
    const steps = runSteps(raw.steps, true);
    return {
      run_id: raw.run_id,
      status: raw.status,
      result: raw.result ?? null,
      steps,
      steps_used: stepsUsed(raw.num_of_steps, steps),
      error: raw.error ? { code: raw.error.code, message: raw.error.message } : null,
      streaming_url: raw.streaming_url ?? null,
    };
  }

  async stepHtml(runId: string, stepId: string): Promise<string> {
    return this.readText(await this.send(stepUrl(runId, stepId, 'html'), { method: 'GET' }));
  }

  // Returned as is so a caller can stream the image body.
  async stepScreenshot(runId: string, stepId: string): Promise<Response> {
    return (await this.send(stepUrl(runId, stepId, 'screenshot'), { method: 'GET' })).res;
  }

  async createMonitor(req: {
    type: 'fetch';
    name: string;
    config: { url: string; format: 'html' };
    schedule_cron: string;
    purpose: string;
    webhook_url: string;
  }): Promise<{ monitor: { id: string }; run: { id: string; results: { text: string }[]; errors: unknown[] } }> {
    return this.json(await this.send(`${AGENT_URL}/v1/monitors`, { method: 'POST', body: req, long: true }));
  }

  async deleteMonitor(id: string): Promise<void> {
    await this.send(`${AGENT_URL}/v1/monitors/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // TinyFish answers with the run under a "run" key, the same wrapper createMonitor returns.
  async runMonitorNow(id: string): Promise<{ id: string; results: { text: string }[]; errors: unknown[] }> {
    type MonitorRun = { id?: unknown; results?: { text: string }[]; errors?: unknown[] };
    const sent = await this.send(`${AGENT_URL}/v1/monitors/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      long: true,
    });
    const body = await this.json<MonitorRun & { run?: MonitorRun }>(sent);
    const run = body.run ?? body;
    if (typeof run.id !== 'string')
      throw new TinyFishError('bad_response', sent.res.status, 'TinyFish monitor run had no id');
    return { id: run.id, results: run.results ?? [], errors: run.errors ?? [] };
  }

  // The balance field name is undocumented: take balance_cents if present, else balance in dollars.
  async wallet(): Promise<{ balance_cents: number }> {
    const sent = await this.send(`${AGENT_URL}/v1/wallet`, { method: 'GET', allowNotFound: true });
    if (sent.res.status === 404) {
      const body = sent.errorBody ?? '';
      if (errorCode(body) === 'FEATURE_NOT_AVAILABLE') return { balance_cents: -1 };
      throw this.failure(sent.res, body);
    }
    const raw = (await this.json<Record<string, unknown> | null>(sent)) ?? {};
    // The budgets are in US cents, so a balance in another currency is refused, not converted.
    if (raw.currency !== undefined && raw.currency !== null && raw.currency !== 'USD') {
      throw new TinyFishError('bad_response', sent.res.status, 'TinyFish wallet balance is not in USD');
    }
    if (typeof raw.balance_cents === 'number') return { balance_cents: raw.balance_cents };
    const dollars = dollarAmount(raw.available_balance);
    if (dollars !== null) return { balance_cents: Math.round(dollars * 100) };
    if (typeof raw.balance === 'number') return { balance_cents: Math.round(raw.balance * 100) };
    throw new TinyFishError('bad_response', sent.res.status, 'TinyFish wallet response had no balance field');
  }

  // Sends one request with the key and a timeout. Network failures become code 'network',
  // timeouts become code 'timeout'. Non-2xx responses throw, except a 404 when allowNotFound is set.
  private async send(
    url: string,
    opts: { method: string; body?: unknown; long?: boolean; allowNotFound?: boolean },
  ): Promise<Sent> {
    const headers: Record<string, string> = { 'X-API-Key': this.#apiKey };
    const signal = AbortSignal.timeout(this.#timeoutMs ?? (opts.long ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS));
    const init: RequestInit = { method: opts.method, headers, signal };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    // Call through a local so the global fetch is not invoked as a method of this object.
    const call = this.#fetchImpl;
    let res: Response;
    try {
      res = await call(url, init);
    } catch {
      throw signal.aborted ? timeoutError() : new TinyFishError('network', 0, 'Could not reach TinyFish');
    }

    const sent: Sent = { res, signal };
    if (res.ok) return sent;

    let body = '';
    try {
      body = await res.text();
    } catch {
      if (signal.aborted) throw timeoutError();
    }
    if (opts.allowNotFound && res.status === 404) return { ...sent, errorBody: body };
    throw this.failure(res, body);
  }

  private async readText(sent: Sent): Promise<string> {
    try {
      return await sent.res.text();
    } catch {
      throw sent.signal.aborted
        ? timeoutError()
        : new TinyFishError('bad_response', sent.res.status, 'TinyFish response body could not be read');
    }
  }

  private async json<T>(sent: Sent): Promise<T> {
    const text = await this.readText(sent);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TinyFishError('bad_response', sent.res.status, 'TinyFish returned a body that is not JSON');
    }
  }

  private failure(res: Response, body: string): TinyFishError {
    const status = res.status;
    if (status === 429) {
      const retry = res.headers.get('Retry-After')?.trim();
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
      const hint = seconds === undefined ? '' : ` Retry after ${seconds} seconds.`;
      const err = new TinyFishError('rate_limited', status, `TinyFish rate limit reached.${hint}`);
      err.retryAfterSeconds = seconds;
      return err;
    }
    if (status === 403 && /custom max steps/i.test(errorMessage(body) ?? '')) {
      return new TinyFishError('step_cap_unavailable', status, 'This TinyFish account has no custom max steps');
    }
    if (status === 401 || status === 403) {
      return new TinyFishError('unauthorised', status, 'TinyFish rejected the API key');
    }
    if (status === 404) {
      return new TinyFishError('not_found', status, 'TinyFish could not find that resource');
    }
    const code = errorCode(body) ?? 'http_error';
    const err = new TinyFishError(code, status, `TinyFish returned HTTP ${status}`);
    const detail = errorMessage(body);
    if (detail !== undefined) err.detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
    return err;
  }
}

/**
 * The last step that has the capture asked for. The closing "Task completed" step has none, and its
 * capture routes answer 404, so the last step is not the one to read. A step whose flag is unset (a
 * source that did not say) counts as a candidate, so the last such step is taken. Undefined when no step
 * has the capture.
 */
export function lastCapture(steps: RunStep[], kind: 'html' | 'screenshot'): RunStep | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const flag = kind === 'html' ? steps[i].has_html : steps[i].has_screenshot;
    if (flag !== false) return steps[i];
  }
  return undefined;
}

/**
 * The latest step whose HTML can still be read. On live runs the closing step has no HTML and
 * the step before it lists a link that answers 404, so the readable page is two or three steps from the
 * end. This goes from the last step backwards over steps not marked as having no HTML, asks for each, and
 * returns the first with a non-empty body. A 404 or an empty body means try the one before. It stops after
 * maxTries requests, or at once on any other error, and then returns null. It never throws.
 */
export async function readLatestHtml(
  client: Pick<TinyFish, 'stepHtml'>,
  runId: string,
  steps: RunStep[],
  maxTries = 4,
): Promise<{ step_id: string; html: string } | null> {
  const found = await readHtmlWhere(client, runId, steps, () => true, maxTries);
  return found === null ? null : { step_id: found.step_id, html: found.html };
}

/**
 * The same walk as readLatestHtml, but a readable page counts only when `accepts` says so. Returns the
 * newest accepted page with accepted true. When no page is accepted it returns the newest readable page
 * with accepted false, so the caller can still keep what the run ended on. Null when no page was readable.
 */
export async function readHtmlWhere(
  client: Pick<TinyFish, 'stepHtml'>,
  runId: string,
  steps: RunStep[],
  accepts: (html: string) => boolean,
  maxTries = 4,
): Promise<{ step_id: string; html: string; accepted: boolean } | null> {
  let newest: { step_id: string; html: string } | null = null;
  let tries = 0;
  for (let i = steps.length - 1; i >= 0 && tries < maxTries; i -= 1) {
    if (steps[i].has_html === false) continue;
    tries += 1;
    try {
      const html = await client.stepHtml(runId, steps[i].step_id);
      if (html === '') continue;
      if (accepts(html)) return { step_id: steps[i].step_id, html, accepted: true };
      newest ??= { step_id: steps[i].step_id, html };
    } catch (err) {
      if (err instanceof TinyFishError && err.status === 404) continue;
      // Any other failure ends the search; callers treat a missing page as no readable page.
      break;
    }
  }
  return newest === null ? null : { ...newest, accepted: false };
}

/**
 * Steps from a run body. TinyFish names the step id `id`; `step_id` is accepted too. A capture flag is set
 * when the body carries the link field, and is true when the link is a non-empty string. With
 * alwaysFlag (the GET run body, whose steps all carry the fields) a missing field counts as no capture;
 * otherwise (a webhook body, whose shape is not captured yet) a missing field leaves the flag unset.
 */
export function runSteps(raw: unknown, alwaysFlag = false): RunStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : typeof e.step_id === 'string' ? e.step_id : null;
    if (id === null) return [];
    const step: RunStep = { step_id: id };
    if (alwaysFlag || 'html' in e) step.has_html = typeof e.html === 'string' && e.html !== '';
    if (alwaysFlag || 'screenshot' in e) step.has_screenshot = typeof e.screenshot === 'string' && e.screenshot !== '';
    return [step];
  });
}

/**
 * The steps a run used: num_of_steps when TinyFish gives a number (it is null while the run is pending),
 * else the length of the step list.
 */
export function stepsUsed(numOfSteps: unknown, steps: RunStep[]): number {
  return typeof numOfSteps === 'number' && Number.isFinite(numOfSteps) && numOfSteps >= 0 ? numOfSteps : steps.length;
}

function timeoutError(): TinyFishError {
  return new TinyFishError('timeout', 0, 'TinyFish did not answer in time');
}

function stepUrl(runId: string, stepId: string, leaf: 'html' | 'screenshot'): string {
  return `${AGENT_URL}/v1/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/${leaf}`;
}

function errorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    return typeof message === 'string' ? message : undefined;
  } catch {
    return undefined;
  }
}

/** A dollar amount from a non-negative number or a plain decimal string such as "36" or "36.5". */
function dollarAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}
