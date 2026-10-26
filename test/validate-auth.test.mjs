// POST /validate/latex and /validate/mermaid take the render key (ops I-743): their scans cost CPU in
// proportion to a crafted body, and only the backend calls them. They follow RENDER_API_KEY_REQUIRED, and
// VALIDATE_API_KEY_REQUIRED=true|false overrides that for them alone. /health stays open. Each keyed request
// logs one [RENDER_AUTH] line with its route, so key-less validate calls can be counted.
//
// The apps here are built by createApp() from the environment, as server.mjs builds the live one.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../app.mjs';
import * as renderAuthModule from '../render-auth.mjs';

const KEY = 'test-validate-key-0123456789';
const ENV_NAMES = ['RENDER_API_KEY', 'RENDER_API_KEY_REQUIRED', 'VALIDATE_API_KEY_REQUIRED'];
const VALIDATIONS = [
  ['/validate/latex', { text: 'Area $x^2$' }],
  ['/validate/mermaid', { diagram: 'graph TD; A-->B' }],
];

const servers = [];
const logLines = [];
const realConsole = { info: console.info, error: console.error };

/** createApp() with these environment variables (others unset), served on a free port. */
async function appFromEnv(vars) {
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  let app;
  try {
    for (const name of ENV_NAMES) {
      if (vars[name] === undefined) delete process.env[name];
      else process.env[name] = vars[name];
    }
    app = createApp({ renderScreenshot: async () => 'AA==' });
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
  const server = http.createServer(app);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(base, path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key !== undefined) headers['x-api-key'] = key;
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

/** The [RENDER_AUTH] lines logged since `from`. */
const authLines = (from) => logLines.slice(from).filter((line) => line.startsWith('[RENDER_AUTH]'));

before(() => {
  const collect = (...args) => logLines.push(args.join(' '));
  console.info = collect;
  console.error = collect;
});

after(() => {
  console.info = realConsole.info;
  console.error = realConsole.error;
  for (const server of servers) server.close();
});

describe('RENDER_API_KEY_REQUIRED=true', () => {
  let base;
  before(async () => {
    base = await appFromEnv({ RENDER_API_KEY: KEY, RENDER_API_KEY_REQUIRED: 'true' });
  });

  for (const [path, body] of VALIDATIONS) {
    test(`${path}: no key 401, wrong key 401, the right key 200`, async () => {
      assert.deepEqual(await post(base, path, body), { status: 401, json: { success: false, error: 'Missing API key' } });
      assert.deepEqual(await post(base, path, body, ''), { status: 401, json: { success: false, error: 'Missing API key' } });
      assert.deepEqual(await post(base, path, body, 'wrong'), { status: 401, json: { success: false, error: 'Invalid API key' } });
      assert.deepEqual(await post(base, path, body, KEY), { status: 200, json: { valid: true } });
    });
  }

  test('a validation result is unchanged behind the key: broken input is still a 400', async () => {
    const { status, json } = await post(base, '/validate/latex', { text: 'This has invalid LaTeX: \\(x = \\frac{a{b}\\)' }, KEY);
    assert.equal(status, 400);
    assert.equal(json.valid, false);
  });

  test('the key is checked before the body is read', async () => {
    assert.equal((await post(base, '/validate/latex', '{not json')).status, 401);
    assert.equal((await post(base, '/validate/mermaid', '{not json')).status, 401);
  });

  test('another spelling of a route gets the same check', async () => {
    for (const path of ['/VALIDATE/LATEX', '/validate/latex/', '/validate/latex?x=1', '/Validate/Mermaid/']) {
      assert.equal((await post(base, path, { text: '$x$', diagram: 'graph TD; A-->B' })).status, 401, path);
    }
  });

  test('/health stays open', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  test('/render-screenshot is unchanged: no key 401, the right key renders', async () => {
    assert.equal((await post(base, '/render-screenshot', { html: '<p>hi</p>' })).status, 401);
    assert.deepEqual(await post(base, '/render-screenshot', { html: '<p>hi</p>' }, KEY), {
      status: 200,
      json: { success: true, screenshot: 'AA==' },
    });
  });

  test('each keyed request logs its key state and route, never the key', async () => {
    const from = logLines.length;
    await post(base, '/validate/latex', { text: '$x$' });
    await post(base, '/VALIDATE/MERMAID/', { diagram: 'graph TD; A-->B' });
    await post(base, '/validate/latex', { text: '$x$' }, 'wrong');
    await post(base, '/validate/mermaid', { diagram: 'graph TD; A-->B' }, KEY);
    await post(base, '/render-screenshot', { html: '<p>hi</p>' }, KEY);
    await fetch(`${base}/health`);
    assert.deepEqual(authLines(from), [
      '[RENDER_AUTH] key=missing required=true route=/validate/latex',
      '[RENDER_AUTH] key=missing required=true route=/validate/mermaid',
      '[RENDER_AUTH] key=invalid required=true route=/validate/latex',
      '[RENDER_AUTH] key=valid required=true route=/validate/mermaid',
      '[RENDER_AUTH] key=valid required=true route=/render-screenshot',
    ]);
    assert.ok(logLines.every((line) => !line.includes(KEY)));
  });
});

describe('the key not required', () => {
  test('a key configured but not required: validations stay open; a wrong key is refused, as for renders', async () => {
    const base = await appFromEnv({ RENDER_API_KEY: KEY });
    for (const [path, body] of VALIDATIONS) {
      assert.deepEqual(await post(base, path, body), { status: 200, json: { valid: true } }, path);
      assert.deepEqual(await post(base, path, body, KEY), { status: 200, json: { valid: true } }, path);
      assert.equal((await post(base, path, body, 'wrong')).status, 401, path);
    }
  });

  test('no key configured: validations stay open and log key=unconfigured', async () => {
    const base = await appFromEnv({});
    const from = logLines.length;
    for (const [path, body] of VALIDATIONS) {
      assert.deepEqual(await post(base, path, body), { status: 200, json: { valid: true } }, path);
    }
    assert.deepEqual(authLines(from), [
      '[RENDER_AUTH] key=unconfigured required=false route=/validate/latex',
      '[RENDER_AUTH] key=unconfigured required=false route=/validate/mermaid',
    ]);
  });
});

describe('VALIDATE_API_KEY_REQUIRED overrides RENDER_API_KEY_REQUIRED for the validate routes only', () => {
  test('false: validations open and log key=missing (the step before requiring), renders still refused', async () => {
    const base = await appFromEnv({ RENDER_API_KEY: KEY, RENDER_API_KEY_REQUIRED: 'true', VALIDATE_API_KEY_REQUIRED: 'false' });
    const from = logLines.length;
    for (const [path, body] of VALIDATIONS) {
      assert.deepEqual(await post(base, path, body), { status: 200, json: { valid: true } }, path);
    }
    assert.equal((await post(base, '/render-screenshot', { html: '<p>hi</p>' })).status, 401);
    assert.deepEqual(authLines(from), [
      '[RENDER_AUTH] key=missing required=false route=/validate/latex',
      '[RENDER_AUTH] key=missing required=false route=/validate/mermaid',
      '[RENDER_AUTH] key=missing required=true route=/render-screenshot',
    ]);
  });

  test('true: validations require the key while renders do not', async () => {
    const base = await appFromEnv({ RENDER_API_KEY: KEY, VALIDATE_API_KEY_REQUIRED: 'true' });
    for (const [path, body] of VALIDATIONS) {
      assert.equal((await post(base, path, body)).status, 401, path);
      assert.equal((await post(base, path, body, KEY)).status, 200, path);
    }
    assert.equal((await post(base, '/render-screenshot', { html: '<p>hi</p>' })).status, 200);
  });

  test('required with no key configured refuses every validation (fail closed)', async () => {
    const base = await appFromEnv({ RENDER_API_KEY_REQUIRED: 'true' });
    for (const [path, body] of VALIDATIONS) {
      assert.equal((await post(base, path, body, KEY)).status, 503, path);
    }
  });

  test('validateAuthSettings: true or false decides; any other value follows RENDER_API_KEY_REQUIRED', () => {
    const { validateAuthSettings } = renderAuthModule;
    assert.equal(typeof validateAuthSettings, 'function');
    const cases = [
      [{}, false],
      [{ RENDER_API_KEY_REQUIRED: 'true' }, true],
      [{ RENDER_API_KEY_REQUIRED: 'true', VALIDATE_API_KEY_REQUIRED: 'false' }, false],
      [{ RENDER_API_KEY_REQUIRED: 'true', VALIDATE_API_KEY_REQUIRED: ' 0 ' }, false],
      [{ RENDER_API_KEY_REQUIRED: '1', VALIDATE_API_KEY_REQUIRED: '' }, true],
      [{ RENDER_API_KEY_REQUIRED: 'true', VALIDATE_API_KEY_REQUIRED: 'no' }, true],
      [{ VALIDATE_API_KEY_REQUIRED: 'TRUE' }, true],
      [{ VALIDATE_API_KEY_REQUIRED: 'yes' }, false],
    ];
    for (const [env, required] of cases) {
      assert.deepEqual(validateAuthSettings({ RENDER_API_KEY: KEY, ...env }), { key: KEY, required }, JSON.stringify(env));
    }
  });
});
