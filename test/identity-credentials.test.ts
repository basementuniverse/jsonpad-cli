/**
 * End-to-end tests for email addresses, password reset and email verification
 * tokens, and sign-in providers, running the built CLI against a fake API
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
  name: 'ada',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  emailVerified: true,
  hasPassword: true,
  tags: [],
  group: 'players',
  lastLoginAt: null,
  activated: true,
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

const ACTING = {
  JSONPAD_IDENTITY_TOKEN: 'identity-token-1',
  JSONPAD_IDENTITY_GROUP: 'players',
};

describe('email addresses', { concurrency: 8 }, () => {
  test('create and register send an email address', async () => {
    const created = await run({
      args: [
        'identities',
        'create',
        '--name',
        'ada',
        '--email',
        'ada@example.com',
      ],
      env: { JSONPAD_IDENTITY_PASSWORD: 'correct-horse' },
      api: routes({ 'POST /identities': ok(IDENTITY) }),
    });

    assert.equal(created.exitCode, 0, created.stderr);
    assert.deepEqual(created.requests[0].body, {
      name: 'ada',
      email: 'ada@example.com',
      password: 'correct-horse',
    });

    const registered = await run({
      args: [
        'identities',
        'register',
        '--name',
        'ada',
        '--email',
        'ada@example.com',
      ],
      env: { JSONPAD_IDENTITY_PASSWORD: 'correct-horse' },
      api: routes({ 'POST /identities/register': ok(IDENTITY) }),
    });

    assert.equal(registered.exitCode, 0, registered.stderr);
    assert.equal((registered.requests[0].body as any).email, 'ada@example.com');
  });

  test('update changes an email address, and --no-email removes it', async () => {
    const changed = await run({
      args: ['identities', 'update', IDENTITY.id, '--email', 'ada@example.org'],
      api: routes({ [`PUT /identities/${IDENTITY.id}`]: ok(IDENTITY) }),
    });

    assert.equal(changed.exitCode, 0, changed.stderr);
    assert.deepEqual(changed.requests[0].body, { email: 'ada@example.org' });

    const removed = await run({
      args: ['identities', 'update', IDENTITY.id, '--no-email'],
      api: routes({ [`PUT /identities/${IDENTITY.id}`]: ok(IDENTITY) }),
    });

    assert.deepEqual(removed.requests[0].body, { email: null });
  });

  test('an identity shows its email address, and whether it is verified', async () => {
    const result = await run({
      args: ['identities', 'get', IDENTITY.id, '-o', 'table'],
      api: routes({ [`GET /identities/${IDENTITY.id}`]: ok(IDENTITY) }),
    });

    assert.match(result.stdout, /Email\s+ada@example\.com/);
    assert.doesNotMatch(result.stdout, /not verified/);

    const unverified = await run({
      args: ['identities', 'get', IDENTITY.id, '-o', 'table'],
      api: routes({
        [`GET /identities/${IDENTITY.id}`]: ok({
          ...IDENTITY,
          emailVerified: false,
        }),
      }),
    });

    assert.match(
      unverified.stdout,
      /Email\s+ada@example\.com \(not verified\)/
    );
  });

  test('login accepts an email address instead of a name', async () => {
    const result = await run({
      args: [
        'identities',
        'login',
        '--email',
        'ada@example.com',
        '-o',
        'token',
      ],
      env: { JSONPAD_IDENTITY_PASSWORD: 'correct-horse' },
      api: routes({
        'POST /identities/login': ok({ ...IDENTITY, token: 'identity-token' }),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].body, {
      email: 'ada@example.com',
      password: 'correct-horse',
    });
    assert.equal(result.stdout, 'identity-token\n');
  });

  test('login refuses both a name and an email address', async () => {
    const result = await run({
      args: ['identities', 'login', '--name', 'ada', '--email', 'a@b.com'],
      env: { JSONPAD_IDENTITY_PASSWORD: 'correct-horse' },
    });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.requests, []);
    assert.match(result.stderr, /not both/);
  });

  test('logout --all ends every session', async () => {
    const result = await run({
      args: ['identities', 'logout', '--all'],
      env: ACTING,
      api: routes({ 'POST /identities/logout': () => ({ status: 204 }) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].body, { all: true });
    assert.match(result.stderr, /Logged out everywhere/);
  });

  test('self update sends the current password when asked for one', async () => {
    const result = await run({
      args: [
        'identities',
        'self',
        'update',
        '--email',
        'ada@example.org',
        '--current-password',
      ],
      env: { ...ACTING, JSONPAD_IDENTITY_CURRENT_PASSWORD: 'correct-horse' },
      api: routes({ 'PUT /identities/self': ok(IDENTITY) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].body, {
      email: 'ada@example.org',
      currentPassword: 'correct-horse',
    });
  });

  test('self update needs the current password somewhere it can read it', async () => {
    const result = await run({
      args: [
        'identities',
        'self',
        'update',
        '--email',
        'a@b.com',
        '--current-password',
      ],
      env: ACTING,
    });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.requests, []);
    assert.match(result.stderr, /JSONPAD_IDENTITY_CURRENT_PASSWORD/);
  });
});

describe('password reset and email verification', { concurrency: 8 }, () => {
  const issued = {
    resetToken: 'reset-token-1',
    expiresAt: '2026-09-02T12:30:00.000Z',
    identity: IDENTITY,
  };

  test('requests a reset token by name, group/name, id or email', async () => {
    const byId = await run({
      args: ['identities', 'password-reset', 'request', IDENTITY.id],
      api: routes({ 'POST /identities/password-reset': ok(issued) }),
    });

    assert.equal(byId.exitCode, 0, byId.stderr);
    assert.deepEqual(byId.requests[0].body, { identityId: IDENTITY.id });

    const byGroupAndName = await run({
      args: ['identities', 'password-reset', 'request', 'players/ada'],
      api: routes({ 'POST /identities/password-reset': ok(issued) }),
    });

    assert.deepEqual(byGroupAndName.requests[0].body, {
      group: 'players',
      name: 'ada',
    });

    const byEmail = await run({
      args: [
        'identities',
        'password-reset',
        'request',
        '--group',
        'players',
        '--email',
        'ada@example.com',
      ],
      api: routes({ 'POST /identities/password-reset': ok(issued) }),
    });

    assert.deepEqual(byEmail.requests[0].body, {
      group: 'players',
      email: 'ada@example.com',
    });
  });

  test('shows the token, its expiry and the identity it is for', async () => {
    const result = await run({
      args: [
        'identities',
        'password-reset',
        'request',
        IDENTITY.id,
        '-o',
        'table',
      ],
      api: routes({ 'POST /identities/password-reset': ok(issued) }),
    });

    assert.match(result.stdout, /Reset token\s+reset-token-1/);
    assert.match(result.stdout, /Identity\s+players\/ada/);
  });

  test('says when no identity matched, and when the token went to a webhook', async () => {
    const noMatch = await run({
      args: [
        'identities',
        'password-reset',
        'request',
        'players/nobody',
        '-o',
        'table',
      ],
      api: routes({
        'POST /identities/password-reset': ok({
          resetToken: null,
          expiresAt: null,
          identity: null,
        }),
      }),
    });

    assert.equal(noMatch.exitCode, 0, noMatch.stderr);
    assert.match(noMatch.stderr, /No activated, unlocked identity matched/);

    const webhook = await run({
      args: [
        'identities',
        'password-reset',
        'request',
        'players/ada',
        '-o',
        'table',
      ],
      api: routes({
        'POST /identities/password-reset': () => ({
          status: 202,
          body: { delivery: 'webhook' },
        }),
      }),
    });

    assert.equal(webhook.exitCode, 0, webhook.stderr);
    assert.match(webhook.stdout, /webhook/);
  });

  test('confirms a reset with a new password', async () => {
    const result = await run({
      args: ['identities', 'password-reset', 'confirm', 'reset-token-1'],
      env: { JSONPAD_IDENTITY_PASSWORD: 'new-password' },
      api: routes({ 'POST /identities/password-reset/confirm': ok(IDENTITY) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].body, {
      resetToken: 'reset-token-1',
      password: 'new-password',
    });
    assert.match(result.stderr, /logged out everywhere/);
  });

  test('requests and confirms an email verification token', async () => {
    const requested = await run({
      args: [
        'identities',
        'email-verification',
        'request',
        IDENTITY.id,
        '-o',
        'table',
      ],
      api: routes({
        'POST /identities/email-verification': ok({
          verificationToken: 'verify-token-1',
          expiresAt: '2026-09-03T10:00:00.000Z',
          identity: IDENTITY,
        }),
      }),
    });

    assert.equal(requested.exitCode, 0, requested.stderr);
    assert.match(requested.stdout, /Verification token\s+verify-token-1/);

    const confirmed = await run({
      args: ['identities', 'email-verification', 'confirm', 'verify-token-1'],
      api: routes({
        'POST /identities/email-verification/confirm': ok(IDENTITY),
      }),
    });

    assert.equal(confirmed.exitCode, 0, confirmed.stderr);
    assert.deepEqual(confirmed.requests[0].body, {
      verificationToken: 'verify-token-1',
    });
  });

  test('needs an identity to request a token for', async () => {
    const result = await run({
      args: ['identities', 'password-reset', 'request'],
    });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.requests, []);
  });
});

describe('sign-in providers', { concurrency: 8 }, () => {
  test("lists an identity group's providers", async () => {
    const result = await run({
      args: ['identities', 'providers', '--group', 'players', '-o', 'table'],
      api: routes({
        'GET /identities/oauth/providers': ok([
          { provider: 'google', name: 'Google' },
          { provider: 'github', name: 'GitHub' },
        ]),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query?.group, ['players']);
    assert.match(result.stdout, /google\s+Google/);
    assert.match(result.stdout, /github\s+GitHub/);
  });

  test('lists and unlinks the accounts an identity can sign in with', async () => {
    const accounts = [
      {
        provider: 'google',
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        avatarUrl: null,
        createdAt: TIMESTAMPS.createdAt,
        lastLoginAt: TIMESTAMPS.updatedAt,
      },
    ];

    const listed = await run({
      args: ['identities', 'self', 'providers', '-o', 'table'],
      env: ACTING,
      api: routes({ 'GET /identities/self/providers': ok(accounts) }),
    });

    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.match(listed.stdout, /Google\s+ada@example\.com/);

    const unlinked = await run({
      args: ['identities', 'self', 'providers', 'unlink', 'google', '-y'],
      env: ACTING,
      api: routes({
        'DELETE /identities/self/providers/google': () => ({ status: 204 }),
      }),
    });

    assert.equal(unlinked.exitCode, 0, unlinked.stderr);
    assert.equal(unlinked.requests.length, 1);
    assert.match(unlinked.stderr, /Unlinked the Google account/);
  });

  test("refuses to remove an identity's last way of signing in", async () => {
    const result = await run({
      args: ['identities', 'self', 'providers', 'unlink', 'google', '-y'],
      env: ACTING,
      api: routes({
        'DELETE /identities/self/providers/google': () => ({
          status: 409,
          body: {
            name: 'IDENTITY_LAST_LOGIN_METHOD',
            code: 20022,
            message: "An identity's last way of signing in can't be removed",
          },
        }),
      }),
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /last way of signing in/);
  });

  test('the self commands need an identity token', async () => {
    const result = await run({
      args: ['identities', 'self', 'providers'],
    });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.requests, []);
    assert.match(result.stderr, /JSONPAD_IDENTITY_TOKEN/);
  });
});
