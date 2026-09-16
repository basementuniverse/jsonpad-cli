/**
 * End-to-end tests for --all, search, stats, events, restore, and items export
 * and import, running the built CLI against a fake API
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

const item = (n: number) => ({
  id: `item-${n}`,
  ...TIMESTAMPS,
  data: { n },
  description: n === 1 ? 'First' : '',
  tags: n === 1 ? ['first'] : [],
  version: '1',
  readonly: false,
  activated: true,
  size: 8,
  identity: null,
});

const event = (n: number, type = 'item-updated') => ({
  id: `event-${n}`,
  ...TIMESTAMPS,
  modelId: 'item-1',
  stream: 'item',
  type,
  version: String(n),
});

const IDENTITY = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  ...TIMESTAMPS,
  name: 'ada',
  displayName: null,
  tags: [],
  group: 'staff',
  lastLoginAt: null,
  activated: true,
};

const TOKEN_SELF = (plan: Record<string, unknown> = {}, usage = {}) => ({
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
    id: 'test',
    name: 'Test',
    rateLimit: null,
    maxRequestsPerMinute: null,
    maxRequestsPerMonth: null,
    ...plan,
  },
  usage: {
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-10-01T00:00:00.000Z',
    requestCount: 0,
    blockedCount: 0,
    requestAllowance: null,
    requestsRemaining: null,
    overdraftAllowance: 0,
    credits: 0,
    storageBytes: 0,
    storageAllowance: null,
    degraded: false,
    ...usage,
  },
});

type Handler = (request: ApiRequest, count: number) => ApiResponse;

const routes =
  (table: Record<string, Handler>) =>
  (request: ApiRequest, count: number): ApiResponse =>
    table[`${request.method} ${request.path}`]?.(request, count) ?? {
      status: 404,
      body: {
        name: 'REQUESTED_ENTITY_NOT_FOUND',
        code: 10004,
        message: `No route for ${request.method} ${request.path}`,
      },
    };

const ok = (body: unknown) => () => ({ status: 200, body });

/**
 * Serve records a page at a time, as the API does
 */
const paged =
  (records: unknown[], map: (record: unknown) => unknown = record => record) =>
  (request: ApiRequest): ApiResponse => {
    const page = Number(request.query.page?.[0] ?? 1);
    const limit = Number(request.query.limit?.[0] ?? 20);
    const start = (page - 1) * limit;

    return {
      status: 200,
      body: {
        page,
        limit,
        total: records.length,
        data: records.slice(start, start + limit).map(map),
      },
    };
  };

const items = (count: number) =>
  Array.from({ length: count }, (_, i) => item(i + 1));

function run(scenario: Omit<Scenario, 'name'>) {
  return runScenario(CLI_BIN, { name: 'test', ...scenario });
}

const pages = (requests: ApiRequest[]) =>
  requests.map(request => request.query.page?.[0]);

describe('--all', { concurrency: 8 }, () => {
  test('fetches every page, 100 at a time, as NDJSON', async () => {
    const result = await run({
      args: ['items', 'recipes', '--all', '--order', 'createdAt'],
      api: routes({ 'GET /lists/recipes/items': paged(items(250)) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(pages(result.requests), ['1', '2', '3']);
    assert.deepEqual(result.requests[0].query, {
      page: ['1'],
      limit: ['100'],
      order: ['createdAt'],
    });

    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 250);
    assert.equal(JSON.parse(lines[249]).id, 'item-250');
  });

  test('--max stops early, and -o json outputs one array', async () => {
    const result = await run({
      args: ['lists', '--all', '--max', '120', '-o', 'json'],
      api: routes({
        'GET /lists': paged(
          Array.from({ length: 300 }, (_, i) => ({
            id: `list-${i}`,
            ...TIMESTAMPS,
          }))
        ),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(pages(result.requests), ['1', '2']);
    assert.equal(JSON.parse(result.stdout).length, 120);
  });

  test('-q outputs every id', async () => {
    const result = await run({
      args: ['identities', '--all', '-q'],
      api: routes({ 'GET /identities': paged([IDENTITY, IDENTITY]) }),
    });

    assert.equal(result.stdout, `${IDENTITY.id}\n${IDENTITY.id}\n`);
  });

  test("can't be combined with --page or --limit", async () => {
    const result = await run({
      args: ['indexes', 'recipes', '--all', '--page', '2'],
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /can't be used with --all/);
    assert.deepEqual(result.requests, []);
  });

  test("items data get --all outputs every item's data", async () => {
    const result = await run({
      args: ['items', 'data', 'get', 'recipes', '--all'],
      api: routes({
        'GET /lists/recipes/items/data': paged(
          items(150),
          record => (record as any).data
        ),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trimEnd().split('\n').length, 150);
    assert.equal(result.stdout.split('\n')[0], '{"n":1}');
  });

  test('a failed page stops the command with the right exit code', async () => {
    const result = await run({
      args: ['items', 'recipes', '--all'],
      api: routes({
        'GET /lists/recipes/items': (request, count) =>
          count === 0
            ? paged(items(150))(request)
            : {
                status: 403,
                body: {
                  name: 'TOKEN_NOT_AUTHORIZED',
                  code: 1,
                  message: 'Not allowed',
                },
              },
      }),
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout.trimEnd().split('\n').length, 100);
    assert.equal(result.stderr, 'Not allowed\n');
  });
});

describe('search, stats and events', { concurrency: 8 }, () => {
  test('lists search', async () => {
    const result = await run({
      args: [
        'lists',
        'search',
        'recipes',
        'pancake',
        '--include-items',
        '-o',
        'table',
      ],
      api: routes({
        'GET /lists/recipes/search': ok([
          { relevance: 0.91234, item: item(1) },
          { relevance: 0.5, item: item(2) },
        ]),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, {
      query: ['pancake'],
      includeItems: ['true'],
    });
    assert.equal(
      result.stdout,
      'RELEVANCE  ID      DESCRIPTION\n0.912      item-1  First\n0.500      item-2  -\n'
    );
  });

  test('lists search checks the query length before searching', async () => {
    const result = await run({ args: ['lists', 'search', 'recipes', 'ab'] });

    assert.equal(result.exitCode, 1);
    assert.equal(
      result.stderr,
      'The search query must be from 3 to 100 characters long\n'
    );
    assert.deepEqual(result.requests, []);
  });

  test('stats as JSON, and --days validation', async () => {
    const stats = { events: { total: 1, totalThisPeriod: 1, metrics: [] } };
    const result = await run({
      args: ['items', 'stats', 'recipes', 'pancakes', '--days', '30'],
      api: routes({ 'GET /lists/recipes/items/pancakes/stats': ok(stats) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, { days: ['30'] });
    assert.deepEqual(JSON.parse(result.stdout), stats);

    const invalid = await run({
      args: ['lists', 'stats', 'recipes', '--days', '91'],
    });
    assert.equal(invalid.exitCode, 1);
    assert.deepEqual(invalid.requests, []);
  });

  test('events pass filters, with dates as ISO 8601', async () => {
    const result = await run({
      args: [
        'items',
        'events',
        'recipes',
        'pancakes',
        '--type',
        'item-updated',
        '--start-at',
        '2026-09-01',
        '--restorable',
        '--include-snapshot',
        '-o',
        'table',
      ],
      api: routes({
        'GET /lists/recipes/items/pancakes/events': ok({
          page: 1,
          limit: 20,
          total: 2,
          data: [event(2), event(1, 'item-created')],
        }),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, {
      type: ['item-updated'],
      startAt: ['2026-09-01T00:00:00.000Z'],
      restorable: ['true'],
      includeSnapshot: ['true'],
    });
    assert.equal(
      result.stdout,
      [
        'ID       TYPE          VERSION  CREATED',
        'event-2  item-updated  2        2026-09-01 10:00Z',
        'event-1  item-created  1        2026-09-01 10:00Z',
        '',
      ].join('\n')
    );
  });

  test('events only accept the types of their resource', async () => {
    const result = await run({
      args: ['lists', 'events', 'recipes', '--type', 'item-created'],
    });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.requests, []);
  });

  test('an identity event, by group/name', async () => {
    const result = await run({
      args: ['identities', 'event', 'staff/ada', 'event-1', '-o', 'table'],
      api: routes({
        'GET /identities': ok({
          page: 1,
          limit: 100,
          total: 1,
          data: [IDENTITY],
        }),
        [`GET /identities/${IDENTITY.id}/events/event-1`]: ok({
          ...event(1, 'identity-created'),
          snapshot: { name: 'ada' },
        }),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^Type +identity-created$/m);
    assert.match(result.stdout, /^Snapshot +\{\n +"name": "ada"\n +\}$/m);
  });

  test('items restore', async () => {
    const result = await run({
      args: ['items', 'restore', 'recipes', 'pancakes', 'event-1', '-q'],
      api: routes({
        'POST /lists/recipes/items/pancakes/events/event-1/restore': ok(
          item(1)
        ),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'item-1\n');
  });
});

describe('items export', { concurrency: 8 }, () => {
  test('outputs every item as NDJSON, oldest first', async () => {
    const result = await run({
      args: ['items', 'export', 'recipes', '--tagged', 'first'],
      api: routes({ 'GET /lists/recipes/items': paged(items(120)) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, {
      page: ['1'],
      limit: ['100'],
      order: ['createdAt'],
      direction: ['asc'],
      tagged: ['first'],
      includeData: ['true'],
    });
    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 120);
    assert.deepEqual(JSON.parse(lines[0]), item(1));
  });

  test('--out writes a file, and --data-only exports only the data', async () => {
    const result = await run({
      args: [
        'items',
        'export',
        'recipes',
        '--out',
        'backup.ndjson',
        '--data-only',
      ],
      outputs: ['backup.ndjson', 'backup.ndjson.partial'],
      api: routes({
        'GET /lists/recipes/items/data': paged(
          items(3),
          record => (record as any).data
        ),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.files['backup.ndjson'], '{"n":1}\n{"n":2}\n{"n":3}\n');
    assert.equal(result.files['backup.ndjson.partial'], null);
    assert.equal(
      result.stderr,
      'Exported 3 items from recipes to backup.ndjson\n'
    );
  });

  test("a failed export doesn't leave a file behind", async () => {
    const result = await run({
      args: ['items', 'export', 'recipes', '--out', 'backup.ndjson'],
      outputs: ['backup.ndjson', 'backup.ndjson.partial'],
      api: routes({
        'GET /lists/recipes/items': (request, count) =>
          count === 0
            ? paged(items(150))(request)
            : { status: 500, text: 'oops' },
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.files['backup.ndjson'], null);
    assert.equal(result.files['backup.ndjson.partial'], null);
  });
});

describe('items import', { concurrency: 8 }, () => {
  const created = (request: ApiRequest): ApiResponse => ({
    status: 200,
    body: item((request.body as any).data?.n ?? 0),
  });
  const withSelf = (table: Record<string, Handler>, self = TOKEN_SELF()) =>
    routes({ 'GET /tokens/self': ok(self), ...table });

  test('creates an item for each line, with only the fields import sets', async () => {
    const result = await run({
      args: ['items', 'import', 'recipes', 'items.ndjson'],
      files: {
        'items.ndjson': `${JSON.stringify(item(1))}\n\n${JSON.stringify(item(2))}\n`,
      },
      api: withSelf({ 'POST /lists/recipes/items': created }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      result.requests.map(request => `${request.method} ${request.path}`),
      [
        'GET /tokens/self',
        'POST /lists/recipes/items',
        'POST /lists/recipes/items',
      ]
    );
    assert.deepEqual(result.requests[1].body, {
      data: { n: 1 },
      description: 'First',
      tags: ['first'],
      readonly: false,
    });
    assert.deepEqual(result.requests[1].query, { includeData: ['false'] });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Created 2 items in recipes\n');
  });

  test('reads a JSON array of data from stdin with --data-only', async () => {
    const result = await run({
      args: ['items', 'import', 'recipes', '-', '--data-only'],
      stdin: '[{"n": 1}, {"n": 2}, {"n": 3}]',
      api: withSelf({ 'POST /lists/recipes/items': created }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      result.requests.slice(1).map(request => request.body),
      [{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }]
    );
  });

  test('--dry-run checks the records without any requests', async () => {
    const result = await run({
      args: ['items', 'import', 'recipes', 'items.ndjson', '--dry-run'],
      files: { 'items.ndjson': '{"data": 1}\n{"data": 2}\n' },
      noToken: true,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests, []);
    assert.equal(
      result.stderr,
      '2 items would be created in recipes. Nothing was imported (dry run)\n'
    );
  });

  test('invalid records stop the import before anything is created', async () => {
    const result = await run({
      args: ['items', 'import', 'recipes', 'items.ndjson'],
      files: { 'items.ndjson': '{"data": 1}\n{oops\n{"title": "no data"}\n' },
      api: withSelf({ 'POST /lists/recipes/items': created }),
    });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.requests, []);
    assert.match(
      result.stderr,
      /^Nothing was imported, because 2 records aren't valid:\n  line 2: isn't valid JSON .*\n  line 3: isn't an item/
    );
  });

  test('stops at the first failure, saying how to resume, with its exit code', async () => {
    const result = await run({
      args: ['items', 'import', 'recipes', 'items.ndjson'],
      files: {
        'items.ndjson':
          '{"data": {"n": 1}}\n\n{"data": {"n": 2}}\n{"data": {"n": 3}}\n',
      },
      api: withSelf({
        'POST /lists/recipes/items': request =>
          (request.body as any).data.n === 2
            ? {
                status: 403,
                body: {
                  name: 'MAX_ITEMS_EXCEEDED',
                  code: 10009,
                  message: 'Max items exceeded (1)',
                },
              }
            : created(request),
      }),
    });

    assert.equal(result.exitCode, 8);
    assert.equal(result.requests.length, 3);
    assert.equal(
      result.stderr,
      'Stopped at line 3: Max items exceeded (1)\n1 item was created before it. To import the rest, fix it and run: tail -n +3 items.ndjson | jsonpad items import recipes -\n'
    );
  });

  test('--continue-on-error carries on, then exits with 1', async () => {
    const result = await run({
      args: [
        'items',
        'import',
        'recipes',
        'items.ndjson',
        '--continue-on-error',
      ],
      files: {
        'items.ndjson':
          '{"data": {"n": 1}}\n{"data": {"n": 2}}\n{"data": {"n": 3}}\n',
      },
      api: withSelf({
        'POST /lists/recipes/items': request =>
          (request.body as any).data.n === 2
            ? {
                status: 400,
                body: { name: 'VALIDATION_ERROR', code: 1, message: 'Nope' },
              }
            : created(request),
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.requests.length, 4);
    assert.equal(
      result.stderr,
      "line 2: Nope\nCreated 2 items in recipes. 1 record failed: line 2\n1 item couldn't be created\n"
    );
  });

  test('warns when the import is bigger than the requests left this month', async () => {
    const result = await run({
      args: ['items', 'import', 'recipes', 'items.ndjson'],
      files: { 'items.ndjson': '{"data": 1}\n{"data": 2}\n' },
      api: withSelf(
        { 'POST /lists/recipes/items': created },
        TOKEN_SELF({}, { requestsRemaining: 1 })
      ),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(
      result.stderr,
      /^warning: this imports 2 items, but the account has 1 requests left this month/
    );
  });
});
