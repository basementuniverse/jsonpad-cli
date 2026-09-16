/**
 * End-to-end tests for identity mode: logging in, acting as an identity, and
 * the self commands, running the built CLI against a fake API
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CLI_BIN,
  runScenario,
  type ApiRequest,
  type ApiResponse,
  type Scenario,
} from './parity/harness.ts';

const TIMESTAMPS = {
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-02T11:30:00.000Z',
};

const IDENTITY = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  ...TIMESTAMPS,
  name: 'zed',
  displayName: null,
  tags: [],
  group: 'players',
  lastLoginAt: null,
  activated: true,
};

const ITEM = {
  id: 'item-1',
  ...TIMESTAMPS,
  data: { a: 1 },
  description: '',
  tags: [],
  version: '1',
  readonly: false,
  activated: true,
  size: 7,
  identity: { id: IDENTITY.id, displayName: null },
};

type Handler = (request: ApiRequest) => ApiResponse;

const routes =
  (table: Record<string, Handler>) =>
  (request: ApiRequest): ApiResponse =>
    table[`${request.method} ${request.path}`]?.(request) ?? {
      status: 404,
      body: { name: 'NOT_FOUND', code: 1, message: 'Not found' },
    };

const ok = (body: unknown) => () => ({ status: 200, body });

function run(scenario: Omit<Scenario, 'name'>) {
  return runScenario(CLI_BIN, {
    name: 'test',
    recordTokens: true,
    ...scenario,
  });
}

const identityHeaders = (requests: ApiRequest[]) =>
  requests.map(({ identityToken, identityGroup }) => ({
    identityToken,
    identityGroup,
  }));

const ACTING = {
  JSONPAD_IDENTITY_TOKEN: 'identity-token-1',
  JSONPAD_IDENTITY_GROUP: 'players',
};

describe('identities login', { concurrency: 8 }, () => {
  const login = (request: ApiRequest): ApiResponse =>
    (request.body as any).password === 'hunter2'
      ? { status: 200, body: { ...IDENTITY, token: "tok'en-1" } }
      : {
          status: 401,
          body: {
            name: 'IDENTITY_NOT_AUTHENTICATED',
            code: 20001,
            message: 'Identity not authenticated',
          },
        };

  test('-o env outputs export commands, quoted for the shell', async () => {
    const result = await run({
      args: [
        'identities',
        'login',
        '--group',
        'players',
        '--name',
        'zed',
        '-o',
        'env',
      ],
      stdin: 'hunter2\n',
      api: routes({ 'POST /identities/login': login }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].body, {
      group: 'players',
      name: 'zed',
      password: 'hunter2',
    });
    assert.equal(
      result.stdout,
      `export JSONPAD_IDENTITY_TOKEN='tok'\\''en-1'\nexport JSONPAD_IDENTITY_GROUP='players'\n`
    );
  });

  test('ignores an identity already in the environment', async () => {
    const result = await run({
      args: ['identities', 'login', '--name', 'zed', '-o', 'token'],
      stdin: 'hunter2',
      env: { JSONPAD_IDENTITY_TOKEN: 'stale', JSONPAD_IDENTITY_GROUP: 'old' },
      api: routes({
        'POST /identities/login': () => ({
          status: 200,
          body: { ...IDENTITY, group: null, token: 'fresh' },
        }),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'fresh\n');
    assert.deepEqual(identityHeaders(result.requests), [
      { identityToken: null, identityGroup: null },
    ]);
  });

  test('-o env unsets the group for an identity without one', async () => {
    const result = await run({
      args: ['identities', 'login', '--name', 'solo', '-o', 'env'],
      env: { JSONPAD_IDENTITY_PASSWORD: 'pw' },
      api: routes({
        'POST /identities/login': () => ({
          status: 200,
          body: { ...IDENTITY, group: null, token: 't' },
        }),
      }),
    });

    assert.equal(
      result.stdout,
      "export JSONPAD_IDENTITY_TOKEN='t'\nunset JSONPAD_IDENTITY_GROUP\n"
    );
  });

  test('-o json outputs the identity and token', async () => {
    const result = await run({
      args: ['identities', 'login', '--name', 'zed'],
      stdin: 'hunter2',
      api: routes({ 'POST /identities/login': login }),
    });

    assert.deepEqual(JSON.parse(result.stdout), {
      identity: IDENTITY,
      token: "tok'en-1",
    });
  });

  test('a wrong password exits with 7, and a locked identity explains the wait', async () => {
    const wrong = await run({
      args: ['identities', 'login', '--name', 'zed'],
      stdin: 'nope',
      api: routes({ 'POST /identities/login': login }),
    });
    assert.equal(wrong.exitCode, 7);
    assert.equal(wrong.stdout, '');

    const locked = await run({
      args: ['identities', 'login', '--name', 'zed'],
      stdin: 'hunter2',
      api: routes({
        'POST /identities/login': () => ({
          status: 429,
          body: {
            name: 'IDENTITY_TOO_MANY_ATTEMPTS',
            code: 20009,
            message: 'Too many failed authentication attempts',
          },
        }),
      }),
    });
    assert.equal(locked.exitCode, 8);
    assert.equal(locked.requests.length, 1);
    assert.match(locked.stderr, /Wait a few seconds and try again/);
  });

  test('needs a name', async () => {
    const result = await run({ args: ['identities', 'login'] });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.requests, []);
  });
});

describe('acting as an identity', { concurrency: 8 }, () => {
  test('items commands send the identity from the environment', async () => {
    const result = await run({
      args: ['items', 'create', 'recipes', '--data', '{"a":1}', '-q'],
      env: ACTING,
      api: routes({ 'POST /lists/recipes/items': ok(ITEM) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(identityHeaders(result.requests), [
      { identityToken: 'identity-token-1', identityGroup: 'players' },
    ]);
  });

  test('--identity-group takes precedence over JSONPAD_IDENTITY_GROUP', async () => {
    const result = await run({
      args: ['items', 'recipes', '--identity-group', 'staff', '-q'],
      env: ACTING,
      api: routes({
        'GET /lists/recipes/items': ok({
          page: 1,
          limit: 20,
          total: 0,
          data: [],
        }),
      }),
    });

    assert.deepEqual(identityHeaders(result.requests), [
      { identityToken: 'identity-token-1', identityGroup: 'staff' },
    ]);
  });

  test('--identity-group without a token is an error', async () => {
    const result = await run({
      args: ['items', 'recipes', '--identity-group', 'staff'],
    });

    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /needs an identity token in JSONPAD_IDENTITY_TOKEN/
    );
    assert.deepEqual(result.requests, []);
  });

  test("commands that don't act on items don't send the identity", async () => {
    const result = await run({
      args: ['lists', 'get', 'recipes', '-q'],
      env: ACTING,
      api: routes({ 'GET /lists/recipes': ok({ id: 'l', ...TIMESTAMPS }) }),
    });

    assert.deepEqual(identityHeaders(result.requests), [
      { identityToken: null, identityGroup: null },
    ]);
  });

  test('whoami says which identity is being acted as', async () => {
    const tokenSelf = {
      token: {
        id: 't',
        ...TIMESTAMPS,
        name: 'Test',
        description: '',
        tags: [],
        permissions: [],
        ips: null,
        expiresAt: null,
        activated: true,
        locked: false,
      },
      plan: {
        id: 'p',
        name: 'Plan',
        rateLimit: null,
        maxRequestsPerMinute: null,
      },
      usage: {
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        requestCount: 0,
        requestAllowance: null,
        requestsRemaining: null,
        credits: 0,
        storageBytes: 0,
        storageAllowance: null,
        degraded: false,
      },
    };

    const valid = await run({
      args: ['whoami', '-o', 'table'],
      env: ACTING,
      api: routes({
        'GET /tokens/self': ok(tokenSelf),
        'GET /identities/self': ok(IDENTITY),
      }),
    });
    assert.equal(valid.exitCode, 0, valid.stderr);
    assert.match(
      valid.stdout,
      /^Identity +players\/zed dddddddd-0000-4000-8000-000000000001, from JSONPAD_IDENTITY_TOKEN$/m
    );

    const invalid = await run({
      args: ['whoami', '-o', 'table'],
      env: ACTING,
      api: routes({
        'GET /tokens/self': ok(tokenSelf),
        'GET /identities/self': () => ({
          status: 401,
          body: {
            name: 'IDENTITY_NOT_AUTHENTICATED',
            code: 1,
            message: 'Nope',
          },
        }),
      }),
    });
    assert.equal(invalid.exitCode, 0, invalid.stderr);
    assert.match(
      invalid.stdout,
      /^Identity +JSONPAD_IDENTITY_TOKEN is set, but isn't valid: Nope$/m
    );

    const json = await run({
      args: ['whoami'],
      env: ACTING,
      api: routes({ 'GET /tokens/self': ok(tokenSelf) }),
    });
    assert.equal(json.requests.length, 1);
  });
});

describe('identities self, register and logout', { concurrency: 8 }, () => {
  test('self needs an identity token', async () => {
    for (const args of [
      ['identities', 'self'],
      ['identities', 'self', 'update', '--name', 'x'],
      ['identities', 'self', 'delete', '--yes'],
      ['identities', 'logout'],
    ]) {
      const result = await run({ args });

      assert.equal(result.exitCode, 1, args.join(' '));
      assert.match(result.stderr, /needs an identity token/);
      assert.deepEqual(result.requests, []);
    }
  });

  test('self get, update and delete act as the identity', async () => {
    const got = await run({
      args: ['identities', 'self', '-q'],
      env: ACTING,
      api: routes({ 'GET /identities/self': ok(IDENTITY) }),
    });
    assert.equal(got.stdout, `${IDENTITY.id}\n`);
    assert.deepEqual(identityHeaders(got.requests), [
      { identityToken: 'identity-token-1', identityGroup: 'players' },
    ]);

    const updated = await run({
      args: [
        'identities',
        'self',
        'update',
        '--no-display-name',
        '--password',
        '-q',
      ],
      env: ACTING,
      stdin: 'new-password',
      api: routes({ 'PUT /identities/self': ok(IDENTITY) }),
    });
    assert.equal(updated.exitCode, 0, updated.stderr);
    assert.deepEqual(updated.requests[0].body, {
      displayName: null,
      password: 'new-password',
    });

    const refused = await run({
      args: ['identities', 'self', 'delete'],
      env: ACTING,
    });
    assert.equal(refused.exitCode, 5);

    const deleted = await run({
      args: ['identities', 'self', 'rm', '-y'],
      env: ACTING,
      api: routes({ 'DELETE /identities/self': () => ({ status: 204 }) }),
    });
    assert.equal(deleted.exitCode, 0, deleted.stderr);
  });

  test('register sends no identity, and logout sends the identity', async () => {
    const registered = await run({
      args: [
        'identities',
        'register',
        '--name',
        'zed',
        '--group',
        'players',
        '-q',
      ],
      env: { ...ACTING, JSONPAD_IDENTITY_PASSWORD: 'pw' },
      api: routes({ 'POST /identities/register': ok(IDENTITY) }),
    });
    assert.equal(registered.exitCode, 0, registered.stderr);
    assert.deepEqual(registered.requests[0].body, {
      group: 'players',
      name: 'zed',
      password: 'pw',
    });
    assert.deepEqual(identityHeaders(registered.requests), [
      { identityToken: null, identityGroup: null },
    ]);

    const loggedOut = await run({
      args: ['identities', 'logout'],
      env: ACTING,
      api: routes({ 'POST /identities/logout': () => ({ status: 204 }) }),
    });
    assert.equal(loggedOut.exitCode, 0, loggedOut.stderr);
    assert.deepEqual(identityHeaders(loggedOut.requests), [
      { identityToken: 'identity-token-1', identityGroup: 'players' },
    ]);
  });
});
