import { describe, expect, it } from 'vitest';
import { lastCapture, readHtmlWhere, readLatestHtml, TinyFish, TinyFishError } from '../src/tinyfish/client';

const KEY = 'tf-test-key-123';

type Call = { url: string; init: RequestInit };

// Returns the queued responses in order and records every request.
function stubFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(...responses: Response[]) {
  const stub = stubFetch(...responses);
  return { tf: new TinyFish(KEY, stub.fetchImpl), calls: stub.calls };
}

// A finished run as GET /v1/runs/{id} returned it (a run on example.com, nothing private in it).
const LIVE_RUN = {
  run_id: '3b99403a-e898-4683-9db2-58cd0aab2d25',
  status: 'COMPLETED',
  goal: 'Navigate to https://example.com to complete the goal: Return the page title. Do nothing else.',
  created_at: '2026-11-09T05:28:57Z',
  started_at: '2026-11-09T05:28:59Z',
  finished_at: '2026-11-09T05:29:06Z',
  num_of_steps: 3,
  result: {
    result: 'Example Domain',
  },
  output_schema: null,
  profile_attached: false,
  profile_id: null,
  error: null,
  streaming_url:
    'https://ip-204-236-155-144.tetra-data.production.tinyfish.io/tf-e40045fe-85da-479d-b53a-ebf5f958f38c/stream/0',
  browser_config: {
    proxy_enabled: false,
    proxy_country_code: null,
  },
  video_url: null,
  steps: [
    {
      id: 'cdcc9659-e38a-4b2f-b392-65daec83ae1e',
      timestamp: '2026-11-09T05:28:59Z',
      status: 'RUNNING',
      action: 'Visit example.com to get page title',
      screenshot:
        'https://agent.tinyfish.ai/runs/3b99403a-e898-4683-9db2-58cd0aab2d25/steps/cdcc9659-e38a-4b2f-b392-65daec83ae1e/screenshot',
      html: 'https://agent.tinyfish.ai/runs/3b99403a-e898-4683-9db2-58cd0aab2d25/steps/cdcc9659-e38a-4b2f-b392-65daec83ae1e/html',
      duration: '0.9s',
    },
    {
      id: '5d061b43-f201-483c-963e-8e37b3595320',
      timestamp: '2026-11-09T05:29:01Z',
      status: 'RUNNING',
      action: 'Get the page title',
      screenshot:
        'https://agent.tinyfish.ai/runs/3b99403a-e898-4683-9db2-58cd0aab2d25/steps/5d061b43-f201-483c-963e-8e37b3595320/screenshot',
      html: 'https://agent.tinyfish.ai/runs/3b99403a-e898-4683-9db2-58cd0aab2d25/steps/5d061b43-f201-483c-963e-8e37b3595320/html',
      duration: '1.0s',
    },
    {
      id: '1431c9ef-3ee5-4143-a18a-9917188b1ca4',
      timestamp: '2026-11-09T05:29:05Z',
      status: 'RUNNING',
      action: 'Return the page title of example.com',
      screenshot:
        'https://agent.tinyfish.ai/runs/3b99403a-e898-4683-9db2-58cd0aab2d25/steps/1431c9ef-3ee5-4143-a18a-9917188b1ca4/screenshot',
      html: 'https://agent.tinyfish.ai/runs/3b99403a-e898-4683-9db2-58cd0aab2d25/steps/1431c9ef-3ee5-4143-a18a-9917188b1ca4/html',
      duration: '0.0s',
    },
    {
      id: 'c5c0183b-cdf7-4212-95d8-3ccbe83dec07',
      timestamp: '2026-11-09T05:29:06Z',
      status: 'COMPLETED',
      action: 'Task completed',
      screenshot: null,
      html: null,
      duration: null,
    },
  ],
};

describe('TinyFish client', () => {
  it('fetchPages posts the URLs with the API key and returns results and errors unchanged', async () => {
    const payload = {
      results: [
        {
          url: 'https://a.example',
          final_url: 'https://a.example/',
          title: 'A',
          description: '',
          language: 'en',
          format: 'markdown',
          text: 'Hello',
          author: null,
          published_date: null,
          latency_ms: 120,
        },
      ],
      errors: [{ url: 'https://b.example', code: 'bot_blocked', message: 'Blocked' }],
    };
    const { tf, calls } = client(json(payload));

    const out = await tf.fetchPages(['https://a.example', 'https://b.example'], {
      format: 'markdown',
      ttl: 60,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.fetch.tinyfish.ai');
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      urls: ['https://a.example', 'https://b.example'],
      format: 'markdown',
      ttl: 60,
    });
    expect(out).toEqual(payload);
  });

  it('search sends a URL-encoded query string with the API key and no body', async () => {
    const { tf, calls } = client(json({ query: 'x', results: [], total_results: 0, page: 1 }));

    await tf.search('licence & permit', { location: 'US', include_domains: 'state.gov' });

    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://api.search.tinyfish.ai/');
    expect(url.searchParams.get('query')).toBe('licence & permit');
    expect(url.searchParams.get('location')).toBe('US');
    expect(url.searchParams.get('include_domains')).toBe('state.gov');
    expect(calls[0].init.method).toBe('GET');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
    expect(calls[0].init.body).toBeUndefined();
  });

  it('search returns the results array as received', async () => {
    const payload = {
      query: 'x',
      results: [{ position: 1, site_name: 'S', title: 'T', snippet: 'N', url: 'https://s.example' }],
      total_results: 1,
      page: 1,
    };
    const { tf } = client(json(payload));
    expect(await tf.search('x')).toEqual(payload);
  });

  it('runAsync posts the request body verbatim to run-async', async () => {
    const req = {
      url: 'https://registry.example',
      goal: 'Find the licence status',
      output_schema: { type: 'object' },
      browser_profile: 'stealth' as const,
      proxy_config: { enabled: true, country_code: 'US' },
      agent_config: { max_steps: 20, max_duration_seconds: 120 },
      capture_config: { html: true, screenshots: false },
      webhook_url: 'https://hook.example/in',
    };
    const { tf, calls } = client(json({ run_id: 'run_1', streaming_url: 'https://stream.example/1' }));

    const out = await tf.runAsync(req);

    expect(calls[0].url).toBe('https://agent.tinyfish.ai/v1/automation/run-async');
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
    expect(JSON.parse(calls[0].init.body as string)).toEqual(req);
    expect(out).toEqual({ run_id: 'run_1', streaming_url: 'https://stream.example/1' });
  });

  it('getRun maps the raw run to RunResult', async () => {
    const { tf, calls } = client(
      json({
        run_id: 'run_1',
        status: 'FAILED',
        result: null,
        steps: [{ step_id: 'st_1' }, { step_id: 'st_2' }],
        error: { code: 'MAX_STEPS_EXCEEDED', message: 'Too many steps' },
      }),
    );

    const run = await tf.getRun('run_1');

    expect(calls[0].url).toBe('https://agent.tinyfish.ai/v1/runs/run_1');
    expect(calls[0].init.method).toBe('GET');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
    expect(run).toEqual({
      run_id: 'run_1',
      status: 'FAILED',
      result: null,
      steps: [
        { step_id: 'st_1', has_html: false, has_screenshot: false },
        { step_id: 'st_2', has_html: false, has_screenshot: false },
      ],
      steps_used: 2,
      error: { code: 'MAX_STEPS_EXCEEDED', message: 'Too many steps' },
      streaming_url: null,
    });
  });

  it('getRun reads a run as TinyFish returns it: step ids, num_of_steps, capture flags, object result', async () => {
    const { tf } = client(json(LIVE_RUN));

    const run = await tf.getRun(LIVE_RUN.run_id);

    expect(run.run_id).toBe('3b99403a-e898-4683-9db2-58cd0aab2d25');
    expect(run.status).toBe('COMPLETED');
    expect(run.steps_used).toBe(3);
    expect(run.steps).toHaveLength(4);
    expect(run.steps.map((s) => s.step_id)).toEqual(LIVE_RUN.steps.map((s) => s.id));
    expect(run.steps.map((s) => s.has_html)).toEqual([true, true, true, false]);
    expect(run.steps.map((s) => s.has_screenshot)).toEqual([true, true, true, false]);
    expect(run.result).toEqual({ result: 'Example Domain' });
    expect(run.error).toBeNull();
    expect(run.streaming_url).toBe(LIVE_RUN.streaming_url);
  });

  it('getRun reports no steps used while a run is pending (num_of_steps null)', async () => {
    const { tf } = client(
      json({ run_id: 'run_p', status: 'PENDING', num_of_steps: null, result: null, error: null, steps: [] }),
    );
    const run = await tf.getRun('run_p');
    expect(run.steps_used).toBe(0);
    expect(run.steps).toEqual([]);
  });

  it('getRun maps a completed run with no error to error null', async () => {
    const { tf } = client(
      json({ run_id: 'run_2', status: 'COMPLETED', result: { ok: true }, steps: [], streaming_url: 'https://s/2' }),
    );
    const run = await tf.getRun('run_2');
    expect(run.error).toBeNull();
    expect(run.steps_used).toBe(0);
    expect(run.result).toEqual({ ok: true });
    expect(run.streaming_url).toBe('https://s/2');
  });

  it('stepHtml returns the raw HTML text of a step', async () => {
    const { tf, calls } = client(new Response('<html><body>Step</body></html>', { status: 200 }));

    const html = await tf.stepHtml('run_1', 'st_1');

    expect(calls[0].url).toBe('https://agent.tinyfish.ai/v1/runs/run_1/steps/st_1/html');
    expect(calls[0].init.method).toBe('GET');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
    expect(html).toBe('<html><body>Step</body></html>');
  });

  it('stepScreenshot returns the Response object as is', async () => {
    const res = new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
    const { tf, calls } = client(res);

    const out = await tf.stepScreenshot('run_1', 'st_1');

    expect(calls[0].url).toBe('https://agent.tinyfish.ai/v1/runs/run_1/steps/st_1/screenshot');
    expect(calls[0].init.method).toBe('GET');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
    expect(out).toBe(res);
  });

  it('createMonitor posts the monitor body and returns the monitor and baseline run', async () => {
    const req = {
      type: 'fetch' as const,
      name: 'Licence page',
      config: { url: 'https://registry.example/x', format: 'html' as const },
      schedule_cron: '0 6 * * *',
      purpose: 'Watch the licence status',
      webhook_url: 'https://hook.example/in',
    };
    const payload = {
      monitor: { id: 'mon_1' },
      run: { id: 'run_9', is_baseline: true, results: [{ text: 'Active' }], errors: [] },
    };
    const { tf, calls } = client(json(payload, 201));

    const out = await tf.createMonitor(req);

    expect(calls[0].url).toBe('https://agent.tinyfish.ai/v1/monitors');
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
    expect(JSON.parse(calls[0].init.body as string)).toEqual(req);
    expect(out).toEqual(payload);
  });

  it('deleteMonitor sends DELETE and resolves on 204', async () => {
    const { tf, calls } = client(new Response(null, { status: 204 }));

    await expect(tf.deleteMonitor('mon_1')).resolves.toBeUndefined();

    expect(calls[0].url).toBe('https://agent.tinyfish.ai/v1/monitors/mon_1');
    expect(calls[0].init.method).toBe('DELETE');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
  });

  it('runMonitorNow posts to the monitor runs endpoint and returns the run', async () => {
    const payload = { id: 'run_10', results: [{ text: 'Expired' }], errors: [] };
    const { tf, calls } = client(json(payload));

    const out = await tf.runMonitorNow('mon_1');

    expect(calls[0].url).toBe('https://agent.tinyfish.ai/v1/monitors/mon_1/runs');
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
    expect(out).toEqual(payload);
  });

  it('runMonitorNow unwraps the run TinyFish returns', async () => {
    // Seen live: POST /v1/monitors/{id}/runs answers 201 with the run under a "run" key.
    const run = { id: 'run_11', is_baseline: false, results: [{ text: 'Clear/Active' }], errors: [] };
    const { tf } = client(json({ run }));

    const out = await tf.runMonitorNow('mon_1');

    expect(out).toEqual({ id: 'run_11', results: [{ text: 'Clear/Active' }], errors: [] });
  });

  it('runMonitorNow rejects an answer with no run id', async () => {
    const { tf } = client(json({ run: { results: [], errors: [] } }));

    await expect(tf.runMonitorNow('mon_1')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('wallet reads balance_cents when present', async () => {
    const { tf, calls } = client(json({ balance_cents: 4250 }));

    expect(await tf.wallet()).toEqual({ balance_cents: 4250 });
    expect(calls[0].url).toBe('https://agent.tinyfish.ai/v1/wallet');
    expect(calls[0].init.method).toBe('GET');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe(KEY);
  });

  it('wallet converts a dollar balance to cents when only balance is present', async () => {
    const { tf } = client(json({ balance: 42.5 }));
    expect(await tf.wallet()).toEqual({ balance_cents: 4250 });
  });

  it('wallet reads the measured available_balance string as dollars', async () => {
    const { tf } = client(
      json({
        available_balance: '36',
        currency: 'USD',
        as_of: '2026-11-09T00:00:00Z',
        auto_reload: { state: 'unconfigured' },
        pending_top_up: null,
        rates: { meters: [], as_of: '2026-11-09T00:00:00Z' },
        agent_top_up_url: 'https://example.test/top-up',
      }),
    );
    expect(await tf.wallet()).toEqual({ balance_cents: 3600 });
  });

  it('wallet reads a decimal available_balance string', async () => {
    const { tf } = client(json({ available_balance: '36.5', currency: 'USD' }));
    expect(await tf.wallet()).toEqual({ balance_cents: 3650 });
  });

  it('wallet reads an available_balance of "0" as 0 cents', async () => {
    const { tf } = client(json({ available_balance: '0' }));
    expect(await tf.wallet()).toEqual({ balance_cents: 0 });
  });

  it('wallet reads a numeric available_balance as dollars', async () => {
    const { tf } = client(json({ available_balance: 12.34 }));
    expect(await tf.wallet()).toEqual({ balance_cents: 1234 });
  });

  it('wallet prefers balance_cents over available_balance', async () => {
    const { tf } = client(json({ balance_cents: 500, available_balance: '36' }));
    expect(await tf.wallet()).toEqual({ balance_cents: 500 });
  });

  it.each(['-5', 'abc', '', '1e3', '3.', '1,5'])('wallet throws bad_response for available_balance %j', async (bad) => {
    const { tf } = client(json({ available_balance: bad }));
    await expect(tf.wallet()).rejects.toMatchObject({ code: 'bad_response', status: 200 });
  });

  it('wallet throws bad_response for a currency other than USD', async () => {
    const { tf } = client(json({ available_balance: '36', currency: 'EUR' }));
    await expect(tf.wallet()).rejects.toMatchObject({ code: 'bad_response', status: 200 });
  });

  it('wallet maps a 404 FEATURE_NOT_AVAILABLE to balance_cents -1', async () => {
    const { tf } = client(json({ error: { code: 'FEATURE_NOT_AVAILABLE', message: 'Not on this plan' } }, 404));
    expect(await tf.wallet()).toEqual({ balance_cents: -1 });
  });

  it('a 429 with Retry-After throws TinyFishError rate_limited without the key', async () => {
    const res = new Response(JSON.stringify({ error: { code: 'whatever', message: 'slow down' } }), {
      status: 429,
      headers: { 'Retry-After': '30', 'X-RateLimit-Remaining': '0' },
    });
    const { tf } = client(res);

    const err = await tf.getRun('run_1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: 'rate_limited', status: 429 });
    expect((err as TinyFishError).message).toContain('30');
    expect((err as TinyFishError).message).not.toContain(KEY);
    expect((err as TinyFishError).message).not.toContain('slow down');
  });

  it('maps 401 and 403 to unauthorised, 404 to not_found, and other errors to the body code or http_error', async () => {
    const cases: [Response, string, number][] = [
      [new Response('{"error":{"code":"bad_key"}}', { status: 401 }), 'unauthorised', 401],
      [new Response('', { status: 403 }), 'unauthorised', 403],
      [new Response('', { status: 404 }), 'not_found', 404],
      [json({ error: { code: 'quota_exceeded', message: 'x' } }, 500), 'quota_exceeded', 500],
      [new Response('oops', { status: 502 }), 'http_error', 502],
    ];
    for (const [res, code, status] of cases) {
      const { tf } = client(res);
      const err = await tf.getRun('run_1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TinyFishError);
      expect(err).toMatchObject({ code, status });
      expect((err as TinyFishError).message).not.toContain(KEY);
    }
  });

  it('keeps the message TinyFish gave with a 400, in detail only, cut to 300 characters', async () => {
    const { tf } = client(json({ error: { code: 'INVALID_INPUT', message: `bad   goal ${'x'.repeat(400)}` } }, 400));
    const err = (await tf.runAsync({ url: 'https://r.example', goal: 'g' }).catch((e: unknown) => e)) as TinyFishError;
    expect(err).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    expect(err.detail?.startsWith('bad goal xxx')).toBe(true);
    expect(err.detail).toHaveLength(300);
    expect(err.message).toBe('TinyFish returned HTTP 400');
  });

  it('maps the refusal of a custom step cap to step_cap_unavailable, and keeps other 403s as unauthorised', async () => {
    const refusal = {
      error: {
        code: 'FORBIDDEN',
        message: 'Your account is not enabled for custom max steps yet. Join the beta program at /beta, then retry.',
      },
    };
    const { tf } = client(json(refusal, 403));
    const err = await tf
      .runAsync({ url: 'https://r.example', goal: 'g', agent_config: { max_steps: 5 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: 'step_cap_unavailable', status: 403 });
    expect((err as TinyFishError).message).not.toContain(KEY);

    const other = client(json({ error: { code: 'FORBIDDEN', message: 'Key revoked' } }, 403));
    expect(await other.tf.getRun('run_1').catch((e: unknown) => e)).toMatchObject({
      code: 'unauthorised',
      status: 403,
    });
  });

  it('a network failure throws TinyFishError with status 0 and code network', async () => {
    const tf = new TinyFish(KEY, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);

    const err = await tf.search('anything').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: 'network', status: 0 });
    expect((err as TinyFishError).message).not.toContain(KEY);
  });
});

describe('TinyFish client timeouts, key and bad responses', () => {
  // A stub that never answers, but rejects when the request signal aborts, as fetch does.
  const hang = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as typeof fetch;

  it('times out a request that never resolves with code timeout and status 0', async () => {
    const tf = new TinyFish(KEY, hang, { timeoutMs: 20 });
    const err = await tf.search('anything').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: 'timeout', status: 0 });
    expect((err as TinyFishError).message).not.toContain(KEY);
  });

  it('applies the timeout to the long monitor calls too when timeoutMs is set', async () => {
    const tf = new TinyFish(KEY, hang, { timeoutMs: 20 });
    await expect(
      tf.createMonitor({
        type: 'fetch',
        name: 'n',
        config: { url: 'https://r.example', format: 'html' },
        schedule_cron: '0 6 * * *',
        purpose: 'p',
        webhook_url: 'https://hook.example/in',
      }),
    ).rejects.toMatchObject({ code: 'timeout', status: 0 });
    await expect(tf.runMonitorNow('mon_1')).rejects.toMatchObject({ code: 'timeout', status: 0 });
  });

  it('does not expose the API key when the client is serialised', () => {
    const { tf } = client();
    expect(JSON.stringify(tf)).not.toContain(KEY);
    expect(Object.keys(tf)).toEqual([]);
  });

  it('a 2xx body that is not JSON throws bad_response with the status', async () => {
    const { tf } = client(new Response('<html>maintenance</html>', { status: 200 }));
    const err = await tf.getRun('run_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: 'bad_response', status: 200 });
    expect((err as TinyFishError).message).not.toContain('maintenance');
  });

  it('a 2xx non-JSON wallet body also throws bad_response', async () => {
    const { tf } = client(new Response('nope', { status: 200 }));
    await expect(tf.wallet()).rejects.toMatchObject({ code: 'bad_response', status: 200 });
  });

  it('exposes Retry-After as retryAfterSeconds on a 429', async () => {
    const { tf } = client(new Response('', { status: 429, headers: { 'Retry-After': '45' } }));
    const err = await tf.search('x').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', status: 429, retryAfterSeconds: 45 });
  });
});

describe('lastCapture', () => {
  const steps = [
    { step_id: 'a', has_html: true, has_screenshot: true },
    { step_id: 'b', has_html: true, has_screenshot: false },
    { step_id: 'done', has_html: false, has_screenshot: false },
  ];

  it('takes the last step that has the capture asked for', () => {
    expect(lastCapture(steps, 'html')?.step_id).toBe('b');
    expect(lastCapture(steps, 'screenshot')?.step_id).toBe('a');
  });

  it('is undefined when no step has it, and never throws on an empty list', () => {
    expect(lastCapture([{ step_id: 'done', has_html: false, has_screenshot: false }], 'html')).toBeUndefined();
    expect(lastCapture([], 'screenshot')).toBeUndefined();
  });

  it('treats a step whose flag the source did not give as a candidate', () => {
    expect(lastCapture([{ step_id: 'x' }, { step_id: 'y' }], 'html')?.step_id).toBe('y');
  });
});

describe('readLatestHtml', () => {
  // A stand-in client: each step id maps to a page, or to the error its request throws.
  function fake(answers: Record<string, string | TinyFishError | Error>) {
    const asked: string[] = [];
    const client = {
      stepHtml: async (_run: string, step: string) => {
        asked.push(step);
        const a = answers[step];
        if (a instanceof Error) throw a;
        return a ?? '';
      },
    };
    return { client, asked };
  }
  const notFound = () => new TinyFishError('not_found', 404, 'TinyFish could not find that resource');
  const steps = (...ids: string[]) => ids.map((step_id) => ({ step_id }));

  it('walks back past the 404 step before the closing step: 2 requests', async () => {
    const { client, asked } = fake({ s1: '<p>one</p>', s2: '<p>two</p>', s3: notFound(), done: notFound() });
    const out = await readLatestHtml(client, 'run_1', [
      ...steps('s1', 's2', 's3'),
      { step_id: 'done', has_html: false },
    ]);
    expect(out).toEqual({ step_id: 's2', html: '<p>two</p>' });
    expect(asked).toEqual(['s3', 's2']);
  });

  it('gives null after 4 requests when 4 in a row answer 404', async () => {
    const { client, asked } = fake({ a: notFound(), b: notFound(), c: notFound(), d: notFound(), e: '<p>far</p>' });
    expect(await readLatestHtml(client, 'run_1', steps('e', 'd', 'c', 'b', 'a'))).toBeNull();
    expect(asked).toEqual(['a', 'b', 'c', 'd']);
  });

  it('gives null at once on any error other than a 404', async () => {
    const { client, asked } = fake({
      s1: '<p>one</p>',
      s2: new TinyFishError('http_error', 500, 'TinyFish returned HTTP 500'),
    });
    expect(await readLatestHtml(client, 'run_1', steps('s1', 's2'))).toBeNull();
    expect(asked).toEqual(['s2']);
    const plain = fake({ s1: '<p>one</p>', s2: new Error('boom') });
    expect(await readLatestHtml(plain.client, 'run_1', steps('s1', 's2'))).toBeNull();
  });

  it('treats an empty body as try the one before, and skips steps that say they have no html', async () => {
    const { client, asked } = fake({ s1: '<p>one</p>', s2: '', s3: '<p>never</p>' });
    const out = await readLatestHtml(client, 'run_1', [
      { step_id: 's1' },
      { step_id: 's2' },
      { step_id: 's3', has_html: false },
    ]);
    expect(out?.step_id).toBe('s1');
    expect(asked).toEqual(['s2', 's1']);
  });

  it('is null for an empty step list and honours maxTries', async () => {
    const { client, asked } = fake({ a: notFound(), b: notFound(), c: '<p>c</p>' });
    expect(await readLatestHtml(client, 'run_1', [])).toBeNull();
    expect(await readLatestHtml(client, 'run_1', steps('c', 'b', 'a'), 2)).toBeNull();
    expect(asked).toEqual(['a', 'b']);
  });
});

describe('readHtmlWhere', () => {
  const pages: Record<string, string> = { s1: '<p>view</p>', s2: '<p>record</p>', s3: '<p>record again</p>' };
  const client = { stepHtml: async (_run: string, step: string) => pages[step] ?? '' };
  const steps = ['s1', 's2', 's3'].map((step_id) => ({ step_id }));
  const isView = (html: string): boolean => html.includes('view');

  it('walks back to the newest page that is accepted', async () => {
    expect(await readHtmlWhere(client, 'run_1', steps, isView)).toEqual({
      step_id: 's1',
      html: '<p>view</p>',
      accepted: true,
    });
  });

  it('gives the newest readable page, not accepted, when no page is accepted', async () => {
    expect(await readHtmlWhere(client, 'run_1', steps, () => false)).toEqual({
      step_id: 's3',
      html: '<p>record again</p>',
      accepted: false,
    });
  });

  it('does not reach an accepted page past maxTries, and is null when nothing is readable', async () => {
    expect((await readHtmlWhere(client, 'run_1', steps, isView, 2))?.accepted).toBe(false);
    expect(await readHtmlWhere(client, 'run_1', [], isView)).toBeNull();
  });
});
