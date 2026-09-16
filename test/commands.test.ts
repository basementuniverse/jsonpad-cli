/**
 * End-to-end tests for the commands added in 1.1.0, running the built CLI
 * against a fake API
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, test } from 'node:test';
import {
  CLI_BIN,
  runScenario,
  type ApiRequest,
  type ApiResponse,
  type Scenario,
} from './parity/harness.ts';

const CONFIG = '.jsonpad/config.json';

const TOKEN_SELF = {
  token: {
    id: '3f2a8c1e-0000-4000-8000-000000000001',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    name: 'Deploy',
    description: '',
    tags: [],
    permissions: [
      { mode: 'allow', action: 'sync-schema' },
      {
        mode: 'allow',
        action: 'view',
        resourceType: 'list',
        listIds: ['l1', 'l2'],
      },
      { mode: 'block', action: 'delete' },
    ],
    ips: null,
    expiresAt: null,
    activated: true,
    locked: false,
  },
  plan: {
    id: 'free',
    name: 'Free',
    rateLimit: 100,
    maxRequestsPerMinute: 60,
    maxRequestsPerMonth: 10000,
    overdraftPercent: 0,
    maxStorageBytes: 10485760,
    maxLists: 5,
    maxItemsPerList: 1000,
    maxIndexesPerList: 5,
    maxItemSize: 102400,
    maxItemVersions: 5,
    maxTokens: 5,
    maxIdentities: 100,
    maxRealtimeConnections: 5,
    generativeAPI: false,
  },
  usage: {
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-09-30T23:59:59.999Z',
    requestCount: 1204,
    blockedCount: 0,
    requestAllowance: 10000,
    requestsRemaining: 8796,
    overdraftAllowance: 0,
    credits: 0,
    storageBytes: 1536,
    storageAllowance: 10485760,
    degraded: false,
  },
};

const LIMIT_HEADERS = {
  'x-request-id': 'req-123',
  'x-rate-limit-total': '60',
  'x-rate-limit-remaining': '58',
  'x-quota-total': '10000',
  'x-quota-remaining': '8796',
  'x-quota-credits': '0',
  'x-quota-reset': '2026-10-01T00:00:00.000Z',
};

const whoamiApi =
  (response: ApiResponse = { status: 200, body: TOKEN_SELF }) =>
  (request: ApiRequest): ApiResponse =>
    request.method === 'GET' && request.path === '/tokens/self'
      ? response
      : {
          status: 404,
          body: { name: 'NOT_FOUND', code: 1, message: 'Not found' },
        };

function run(scenario: Omit<Scenario, 'name'>) {
  return runScenario(CLI_BIN, { name: 'test', ...scenario });
}

/**
 * A port nothing is listening on
 */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));

  return port;
}

function config(value: unknown) {
  return { [CONFIG]: JSON.stringify(value) };
}

const PROFILES = {
  defaultProfile: 'prod',
  profiles: {
    prod: { token: 'prod-token-0001', apiUrl: '{api}' },
    local: { token: 'local-token-0002', apiUrl: '{api}' },
  },
};

const tokens = (requests: ApiRequest[]) =>
  requests.map(request => request.token);

describe('whoami', { concurrency: 8 }, () => {
  test('outputs JSON when stdout is not a terminal', async () => {
    const result = await run({ args: ['whoami'], api: whoamiApi() });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), TOKEN_SELF);
    assert.equal(result.stderr, '');
    assert.deepEqual(
      result.requests.map(request => `${request.method} ${request.path}`),
      ['GET /tokens/self']
    );
  });

  test('outputs a table with --output table', async () => {
    const result = await run({
      args: ['whoami', '-o', 'table'],
      api: whoamiApi(),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(
      result.stdout,
      [
        'Token        Deploy 3f2a8c1e-0000-4000-8000-000000000001',
        'Status       active',
        'Using        JSONPAD_TOKEN',
        'API          {api}',
        'IPs          any',
        'Plan         Free',
        'Rate limit   60 requests per minute, 100ms between requests',
        'Requests     1,204 of 10,000, 8,796 left (2026-09-01 to 2026-09-30)',
        'Storage      1.5 KB of 10.0 MB',
        'Permissions',
        '             allow sync-schema',
        '             allow view list (lists: l1, l2)',
        '             block delete',
        '',
      ].join('\n')
    );
  });

  test('outputs the token id with --quiet', async () => {
    const result = await run({ args: ['whoami', '-q'], api: whoamiApi() });

    assert.equal(result.stdout, `${TOKEN_SELF.token.id}\n`);
  });

  test('exits with 7 when the token is refused', async () => {
    const result = await run({
      args: ['whoami'],
      api: whoamiApi({
        status: 401,
        body: {
          name: 'USER_NOT_AUTHENTICATED',
          code: 11002,
          message: 'Invalid API token',
        },
      }),
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Invalid API token\n');
  });

  test("says which URL it couldn't connect to", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    const result = await run({ args: ['whoami', '--api-url', url] });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, `Can't connect to ${url} (ECONNREFUSED)\n`);
  });
});

describe('profiles', { concurrency: 8 }, () => {
  test('the default profile is used without JSONPAD_TOKEN', async () => {
    const result = await run({
      args: ['whoami', '-o', 'table'],
      noToken: true,
      env: { JSONPAD_API_URL: 'http://127.0.0.1:1' },
      files: config(PROFILES),
      recordTokens: true,
      api: whoamiApi(),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(tokens(result.requests), ['prod-token-0001']);
    assert.match(result.stdout, /^Using {8}profile prod$/m);
    assert.match(result.stdout, /^API {10}\{api\}$/m);
  });

  test('--profile, before or after the command, comes before JSONPAD_TOKEN', async () => {
    for (const args of [
      ['--profile', 'local', 'whoami'],
      ['whoami', '--profile', 'local'],
    ]) {
      const result = await run({
        args,
        files: config(PROFILES),
        recordTokens: true,
        api: whoamiApi(),
      });

      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(tokens(result.requests), ['local-token-0002']);
    }
  });

  test('JSONPAD_TOKEN comes before the default profile', async () => {
    const result = await run({
      args: ['whoami'],
      files: config(PROFILES),
      recordTokens: true,
      api: whoamiApi(),
    });

    assert.deepEqual(tokens(result.requests), ['test-token']);
  });

  test('the schema commands use profiles too', async () => {
    const result = await run({
      args: ['sync-schema', '--profile', 'local', '--dry-run'],
      files: {
        ...config(PROFILES),
        'jsonpad-schema.json': JSON.stringify({ lists: {} }),
      },
      recordTokens: true,
      api: () => ({
        status: 200,
        body: {
          syncId: 's',
          dryRun: true,
          applied: false,
          prune: false,
          scope: null,
          summary: {
            create: 0,
            update: 0,
            adopt: 0,
            delete: 0,
            noChange: 0,
            error: 0,
            builds: 0,
            destructive: 0,
          },
          changes: [],
          blockedBy: null,
        },
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(tokens(result.requests), ['local-token-0002']);
  });

  test('an unknown profile exits with 6', async () => {
    const result = await run({
      args: ['whoami', '--profile', 'ghost'],
      files: config(PROFILES),
    });

    assert.equal(result.exitCode, 6);
    assert.equal(
      result.stderr,
      'There\'s no profile named "ghost". Run jsonpad config list to see your profiles\n'
    );
  });
});

describe('--verbose', () => {
  test('logs requests, and the rate limit and quota, on stderr', async () => {
    const result = await run({
      args: ['whoami', '--verbose'],
      api: whoamiApi({ status: 200, body: TOKEN_SELF, headers: LIMIT_HEADERS }),
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), TOKEN_SELF);
    assert.match(
      result.stderr,
      /^> GET \{api\}\/tokens\/self\n< 200 OK \(\d+ms, request req-123\)\nrate limit 58\/60 left this minute · quota 8,796\/10,000 left, resets 2026-10-01\n$/
    );
    assert.doesNotMatch(result.stderr, /test-token/);
  });

  test('works with the schema commands, without changing their stdout', async () => {
    const result = await run({
      args: ['export-schema', '-V'],
      api: () => ({
        status: 200,
        body: { document: { lists: {} }, warnings: [] },
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '{\n  "lists": {}\n}\n');
    assert.match(result.stderr, /^> GET \{api\}\/sync-schema\n< 200 OK/);
  });
});

describe('retries', () => {
  test('a rate limited request is retried, including by the schema commands', async () => {
    const result = await run({
      args: ['rebuild-index', 'recipes', 'title'],
      api: (_request, count) =>
        count === 0
          ? {
              status: 429,
              headers: { 'retry-after': '0' },
              body: {
                name: 'RATE_LIMIT_EXCEEDED',
                code: 10007,
                message: 'Rate limit exceeded',
              },
            }
          : { status: 200, body: { id: 'i1', createdAt: '', updatedAt: '' } },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.requests.length, 2);
    assert.equal(result.stdout, 'Rebuilding index recipes/title\n');
    // A short wait isn't worth mentioning
    assert.equal(result.stderr, '');
  });

  test('an exhausted quota is not retried, and exits with 8', async () => {
    const result = await run({
      args: ['whoami'],
      api: whoamiApi({
        status: 429,
        headers: { 'retry-after': '86400' },
        body: {
          name: 'QUOTA_EXCEEDED',
          code: 10013,
          message: 'Monthly request quota exceeded',
        },
      }),
    });

    assert.equal(result.exitCode, 8);
    assert.equal(result.requests.length, 1);
    assert.equal(result.stderr, 'Monthly request quota exceeded\n');
  });
});

describe('config', { concurrency: 8 }, () => {
  test('set-profile reads the token from stdin, and writes a private file', async () => {
    const result = await run({
      args: [
        'config',
        'set-profile',
        'local',
        '--api-url',
        'http://localhost:3000',
      ],
      stdin: 'secret-token-1234\n',
      outputs: [CONFIG],
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      `Added profile local (the default) in {cwd}/${CONFIG}\nRun jsonpad whoami to check the token\n`
    );
    assert.deepEqual(JSON.parse(result.files[CONFIG]!), {
      profiles: {
        local: { token: 'secret-token-1234', apiUrl: 'http://localhost:3000' },
      },
      defaultProfile: 'local',
    });
  });

  test('set-profile keeps the token when updating a profile with empty stdin', async () => {
    const result = await run({
      args: [
        'config',
        'set-profile',
        'local',
        '--api-url',
        'http://new',
        '--default',
      ],
      files: config(PROFILES),
      outputs: [CONFIG],
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.files[CONFIG]!).profiles.local, {
      token: 'local-token-0002',
      apiUrl: 'http://new',
    });
    assert.equal(JSON.parse(result.files[CONFIG]!).defaultProfile, 'local');
  });

  test('set-profile needs a token for a new profile, and a valid name and URL', async () => {
    const noToken = await run({ args: ['config', 'set-profile', 'new'] });
    assert.equal(noToken.exitCode, 1);
    assert.match(noToken.stderr, /Pass it on stdin/);

    const badName = await run({
      args: ['config', 'set-profile', 'a/b'],
      stdin: 'x',
    });
    assert.equal(badName.exitCode, 1);
    assert.match(badName.stderr, /isn't a valid profile name/);

    const badUrl = await run({
      args: ['config', 'set-profile', 'x', '--api-url', 'nope'],
      stdin: 'x',
    });
    assert.equal(badUrl.exitCode, 1);
    assert.match(badUrl.stderr, /--api-url must be a URL/);
  });

  test('list masks tokens, in every format', async () => {
    const json = await run({
      args: ['config', 'list'],
      files: config(PROFILES),
    });
    assert.deepEqual(JSON.parse(json.stdout), [
      { name: 'prod', apiUrl: '{api}', token: '••••0001', default: true },
      { name: 'local', apiUrl: '{api}', token: '••••0002', default: false },
    ]);

    const table = await run({
      args: ['config', 'ls', '-o', 'table'],
      files: config(PROFILES),
    });
    assert.equal(
      table.stdout,
      '   NAME   TOKEN     API URL\n*  prod   ••••0001  {api}\n   local  ••••0002  {api}\n'
    );

    const ids = await run({
      args: ['config', 'list', '-q'],
      files: config(PROFILES),
    });
    assert.equal(ids.stdout, 'prod\nlocal\n');
  });

  test('list with no profiles', async () => {
    const result = await run({ args: ['config', 'list', '-o', 'table'] });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /No profiles/);
  });

  test('use changes the default profile, and exits with 6 for an unknown one', async () => {
    const result = await run({
      args: ['config', 'use', 'local'],
      files: config(PROFILES),
      outputs: [CONFIG],
    });
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.files[CONFIG]!).defaultProfile, 'local');

    const unknown = await run({
      args: ['config', 'use', 'ghost'],
      files: config(PROFILES),
    });
    assert.equal(unknown.exitCode, 6);
  });

  test("remove needs --yes when it can't ask, exiting with 5", async () => {
    const refused = await run({
      args: ['config', 'remove', 'prod'],
      files: config(PROFILES),
      outputs: [CONFIG],
    });
    assert.equal(refused.exitCode, 5);
    assert.equal(
      refused.stderr,
      'Remove the profile prod? Run again with --yes to confirm\n'
    );
    assert.ok(JSON.parse(refused.files[CONFIG]!).profiles.prod);

    const removed = await run({
      args: ['config', 'rm', 'prod', '--yes'],
      files: config(PROFILES),
      outputs: [CONFIG],
    });
    assert.equal(removed.exitCode, 0);
    assert.deepEqual(JSON.parse(removed.files[CONFIG]!), {
      profiles: { local: PROFILES.profiles.local },
    });
    assert.match(removed.stderr, /It was the default profile/);
  });

  test('path shows the config file', async () => {
    const result = await run({ args: ['config', 'path'] });

    assert.equal(result.stdout, `{cwd}/${CONFIG}\n`);
  });
});
