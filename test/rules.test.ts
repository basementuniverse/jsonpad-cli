/**
 * The write rules commands, and the rule files schema sync resolves
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

const RULES = [
  'allow write "writers": "writer" in token.tags;',
  'require update "status": old.status != "sent" else "a sent item can\'t change";',
].join('\n');

const TESTS = {
  tests: [
    {
      name: 'writers can update',
      action: 'update',
      old: { status: 'draft' },
      merge: { status: 'ready' },
      token: { id: 't', tags: ['writer'] },
      expect: 'allow',
    },
    {
      name: 'readers cannot',
      action: 'update',
      old: { status: 'draft' },
      merge: { status: 'ready' },
      expect: 'deny',
    },
    {
      name: 'a sent item is final',
      action: 'update',
      old: { status: 'sent' },
      merge: { status: 'draft' },
      token: { id: 't', tags: ['writer'] },
      expect: { fail: "a sent item can't change" },
    },
  ],
};

const LIST = {
  id: '3f2a8c1e-0000-4000-8000-000000000001',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  name: 'Games',
  description: '',
  tags: [],
  pathName: 'games',
  schema: null,
  rules: RULES,
  rulesTests: TESTS,
  pinned: false,
  readonly: false,
  realtime: false,
  protected: false,
  indexable: true,
  generative: false,
  generativePrompt: '',
  activated: true,
  itemCount: 2,
};

function run(scenario: Omit<Scenario, 'name'>) {
  return runScenario(CLI_BIN, { name: 'test', ...scenario });
}

function listApi(overrides: Partial<typeof LIST> = {}) {
  return (request: ApiRequest): ApiResponse => {
    if (request.method === 'GET' && request.path === '/lists/games') {
      return { status: 200, body: { ...LIST, ...overrides } };
    }
    if (request.method === 'PUT' && request.path === '/lists/games') {
      return {
        status: 200,
        body: { ...LIST, ...overrides, ...(request.body as object) },
      };
    }
    return {
      status: 404,
      body: { name: 'NOT_FOUND', code: 1, message: 'Not found' },
    };
  };
}

describe('rules check', () => {
  test('accepts rules that compile', async () => {
    const result = await run({
      args: ['rules', 'check', 'games.rules'],
      files: { 'games.rules': RULES },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /✓ games\.rules compiles/);
    assert.deepEqual(result.requests, []);
  });

  test("shows the checker's warnings", async () => {
    const result = await run({
      args: ['rules', 'check', 'games.rules'],
      files: { 'games.rules': 'allow update: identity != null;' },
    });

    assert.equal(result.exitCode, 0);
    assert.match(
      result.stdout,
      /games\.rules:1:1 warning no rule covers create or delete.*\[uncovered-operations\]/
    );
  });

  test('reports errors with their position, and exits 1', async () => {
    const result = await run({
      args: ['rules', 'check', 'games.rules'],
      files: { 'games.rules': 'allow update: identty != null;' },
    });

    assert.equal(result.exitCode, 1);
    assert.match(
      result.stdout,
      /games\.rules:1:15 error unknown name "identty" \(did you mean "identity"\?\) \[unknown-name\]/
    );
    assert.match(result.stderr, /games\.rules has 1 error/);
  });

  test('fails on warnings with --strict', async () => {
    const result = await run({
      args: ['rules', 'check', 'games.rules', '--strict'],
      files: { 'games.rules': 'allow update: identity != null;' },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /1 warning \(--strict\)/);
  });

  test("says when the file isn't there", async () => {
    const result = await run({ args: ['rules', 'check', 'nope.rules'] });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Can't find nope\.rules/);
  });
});

describe('rules test', () => {
  test('runs the tests next to the rule file, without the network', async () => {
    const result = await run({
      args: ['rules', 'test', 'games.rules'],
      files: {
        'games.rules': RULES,
        'games.tests.json': JSON.stringify(TESTS),
      },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /✓ writers can update/);
    assert.match(result.stdout, /✓ a sent item is final/);
    assert.match(result.stdout, /3 passed, 0 failed/);
    assert.deepEqual(result.requests, []);
  });

  test('exits 9 when a test fails, and says what happened', async () => {
    const failing = structuredClone(TESTS);
    failing.tests[1].expect = 'allow';
    const result = await run({
      args: ['rules', 'test', 'games.rules', 'custom.json'],
      files: {
        'games.rules': RULES,
        'custom.json': JSON.stringify(failing),
      },
    });

    assert.equal(result.exitCode, 9);
    assert.match(result.stdout, /✗ readers cannot deny \(expected allow\)/);
    assert.match(result.stderr, /1 of 3 tests failed/);
  });

  test('filters tests by name and outputs JSON', async () => {
    const result = await run({
      args: ['rules', 'test', 'games.rules', '--filter', 'sent', '--json'],
      files: {
        'games.rules': RULES,
        'games.tests.json': JSON.stringify(TESTS),
      },
    });

    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.passed, 1);
    assert.deepEqual(
      output.results.map((r: { name: string }) => r.name),
      ['a sent item is final']
    );
  });

  test('reports a test document with the wrong shape', async () => {
    const result = await run({
      args: ['rules', 'test', 'games.rules'],
      files: {
        'games.rules': RULES,
        'games.tests.json': JSON.stringify({ tests: [{ name: 'x' }] }),
      },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /isn't a valid test document/);
    assert.match(result.stderr, /tests\[0\]\.action/);
  });

  test("runs the list's stored tests against the API with --list", async () => {
    const result = await run({
      args: ['rules', 'test', '--list', 'games'],
      api: (request: ApiRequest): ApiResponse => {
        if (request.path === '/lists/games/rules/test') {
          const body = request.body as {
            action: string;
            token?: { tags: string[] };
          };
          const allowed = !!body.token?.tags?.includes('writer');
          return {
            status: 200,
            body: {
              allowed,
              stage: allowed ? 'ok' : 'allow',
              status: allowed ? 200 : 403,
              code: allowed ? null : 'WRITE_RULE_DENIED',
              message: allowed ? null : 'Write denied by list rules',
              statement: null,
              operation: 'update',
              action: 'update',
              engineVersion: '1.0.0',
              languageVersion: 1,
              diagnostics: [],
              budget: { used: 10, limit: 100000 },
              statements: [],
            },
          };
        }
        return listApi()(request);
      },
    });

    // The fake API allows any write by a token tagged "writer", so the test
    // that expects a failure doesn't get one
    assert.equal(result.exitCode, 9);
    assert.match(result.stdout, /✓ writers can update/);
    assert.match(
      result.stdout,
      /✗ a sent item is final \(the API said allow\)/
    );
    assert.deepEqual(
      result.requests.map(request => `${request.method} ${request.path}`),
      [
        'GET /lists/games',
        'POST /lists/games/rules/test',
        'POST /lists/games/rules/test',
        'POST /lists/games/rules/test',
      ]
    );
  });

  test('warns when the API has a different rules engine', async () => {
    const result = await run({
      args: ['rules', 'test', '--list', 'games', '--filter', 'writers'],
      api: (request: ApiRequest): ApiResponse =>
        request.path === '/lists/games/rules/test'
          ? {
              status: 200,
              body: {
                allowed: true,
                stage: 'ok',
                status: 200,
                code: null,
                message: null,
                statement: null,
                operation: 'update',
                action: 'update',
                engineVersion: '9.9.9',
                languageVersion: 1,
                diagnostics: [],
                budget: { used: 10, limit: 100000 },
                statements: [],
              },
            }
          : listApi()(request),
    });

    assert.equal(result.exitCode, 0);
    assert.match(
      result.stderr,
      /this CLI has rules engine .* and the API has 9\.9\.9/
    );
  });
});

describe('rules eval', () => {
  test('shows what each rule did, without the network', async () => {
    const result = await run({
      args: [
        'rules',
        'eval',
        'games.rules',
        '--action',
        'update',
        '--old',
        '{"status":"draft"}',
        '--merge',
        '{"status":"ready"}',
        '--token',
        '{"id":"t","tags":["writer"]}',
      ],
      files: { 'games.rules': RULES },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /allowed by allow "writers" on line 1/);
    assert.match(result.stdout, /budget used/);
    assert.deepEqual(result.requests, []);
  });

  test('exits 9 when the write is denied, and lists the rules', async () => {
    const result = await run({
      args: [
        'rules',
        'eval',
        'games.rules',
        '--action',
        'update',
        '--old',
        '{"status":"draft"}',
        '--new',
        '{"status":"ready"}',
      ],
      files: { 'games.rules': RULES },
    });

    assert.equal(result.exitCode, 9);
    assert.match(result.stdout, /denied \(403, at the allow stage\)/);
    assert.match(result.stdout, /allow "writers": false/);
    assert.match(result.stderr, /The write is denied by the rules/);
  });

  test('reports a failing require statement with its message', async () => {
    const result = await run({
      args: [
        'rules',
        'eval',
        'games.rules',
        '--action',
        'update',
        '--old',
        '{"status":"sent"}',
        '--merge',
        '{"status":"draft"}',
        '--token',
        '{"id":"t","tags":["writer"]}',
      ],
      files: { 'games.rules': RULES },
    });

    assert.equal(result.exitCode, 9);
    assert.match(
      result.stdout,
      /failed \(400, at the require stage\): a sent item can't change/
    );
  });

  test('checks with the API when given --list', async () => {
    const result = await run({
      args: [
        'rules',
        'eval',
        '--list',
        'games',
        '--action',
        'delete',
        '--item',
        'i1',
      ],
      api: (request: ApiRequest): ApiResponse =>
        request.path === '/lists/games/rules/test'
          ? {
              status: 200,
              body: {
                allowed: true,
                stage: 'ok',
                status: 200,
                code: null,
                message: null,
                statement: {
                  index: 0,
                  kind: 'allow',
                  label: 'writers',
                  line: 1,
                },
                operation: 'delete',
                action: 'delete',
                engineVersion: '1.0.0',
                languageVersion: 1,
                diagnostics: [],
                budget: { used: 12, limit: 100000 },
                statements: [],
              },
            }
          : listApi()(request),
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /allowed by allow "writers" on line 1/);
    assert.deepEqual(
      (result.requests[0]!.body as { action: string; itemId: string }).action,
      'delete'
    );
    assert.equal((result.requests[0]!.body as { itemId: string }).itemId, 'i1');
  });

  test('refuses --item without --list', async () => {
    const result = await run({
      args: [
        'rules',
        'eval',
        'games.rules',
        '--action',
        'create',
        '--item',
        'i1',
        '--new',
        '{}',
      ],
      files: { 'games.rules': RULES },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--item and --identity-id need --list/);
  });
});

describe('lists rules', () => {
  test('get writes the rules to stdout, or a file', async () => {
    const result = await run({
      args: ['lists', 'rules', 'get', 'games'],
      api: listApi(),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${RULES}\n`);

    const toFile = await run({
      args: ['lists', 'rules', 'get', 'games', '--out', 'games.rules'],
      api: listApi(),
      outputs: ['games.rules'],
    });
    assert.equal(toFile.files['games.rules'], `${RULES}\n`);
  });

  test('get --tests writes the tests as JSON', async () => {
    const result = await run({
      args: ['lists', 'rules', 'get', 'games', '--tests'],
      api: listApi(),
    });

    assert.deepEqual(JSON.parse(result.stdout), TESTS);
  });

  test("says when the token can't see the rules", async () => {
    const result = await run({
      args: ['lists', 'rules', 'get', 'games'],
      api: (request: ApiRequest): ApiResponse => {
        const { rules, rulesTests, ...withoutRules } = LIST;
        return request.path === '/lists/games'
          ? { status: 200, body: withoutRules }
          : { status: 404, body: {} };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /can't see the list's write rules/);
  });

  test('set checks the rules before sending them', async () => {
    const result = await run({
      args: [
        'lists',
        'rules',
        'set',
        'games',
        'games.rules',
        '--tests',
        'games.tests.json',
      ],
      files: {
        'games.rules': RULES,
        'games.tests.json': JSON.stringify(TESTS),
      },
      api: listApi(),
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /3 passed, 0 failed/);
    assert.match(result.stderr, /Saved the write rules on games/);
    const [request] = result.requests;
    assert.equal(request!.method, 'PUT');
    assert.deepEqual(request!.body, { rules: RULES, rulesTests: TESTS });
  });

  test("set doesn't send rules that fail their tests", async () => {
    const failing = structuredClone(TESTS);
    failing.tests[1].expect = 'allow';
    const result = await run({
      args: [
        'lists',
        'rules',
        'set',
        'games',
        'games.rules',
        '--tests',
        'games.tests.json',
      ],
      files: {
        'games.rules': RULES,
        'games.tests.json': JSON.stringify(failing),
      },
      api: listApi(),
    });

    assert.equal(result.exitCode, 9);
    assert.deepEqual(result.requests, []);
  });

  test('set --remove clears the rules', async () => {
    const result = await run({
      args: ['lists', 'rules', 'set', 'games', '--remove'],
      api: listApi(),
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.requests[0]!.body, { rules: null });
    assert.match(result.stderr, /Removed the write rules from games/);
  });

  test('denials lists what the rules refused', async () => {
    const result = await run({
      args: ['lists', 'rules', 'denials', 'games', '-o', 'table'],
      api: (request: ApiRequest): ApiResponse =>
        request.path === '/lists/games/rules/denials'
          ? {
              status: 200,
              body: {
                limit: 50,
                data: [
                  {
                    id: 'd1',
                    createdAt: '2026-09-20T12:00:00.000Z',
                    updatedAt: '2026-09-20T12:00:00.000Z',
                    itemId: 'i1',
                    identityId: 'id1',
                    tokenId: 't1',
                    operation: 'update',
                    stage: 'require',
                    statementIndex: 1,
                    statementLabel: 'status',
                    statementLine: 2,
                    reason: 'require-failed',
                  },
                  {
                    id: 'd2',
                    createdAt: '2026-09-20T11:00:00.000Z',
                    updatedAt: '2026-09-20T11:00:00.000Z',
                    itemId: null,
                    identityId: null,
                    tokenId: 't1',
                    operation: 'create',
                    stage: 'allow',
                    statementIndex: null,
                    statementLabel: null,
                    statementLine: null,
                    reason: 'no-allow-passed',
                  },
                ],
              },
            }
          : { status: 404, body: {} },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /require "status" on line 2/);
    assert.match(result.stdout, /no allow statement/);
  });
});

describe('schema sync with rule files', () => {
  const document = {
    lists: {
      games: {
        name: 'Games',
        indexable: true,
        rulesFile: 'rules/games.rules',
        rulesTestsFile: 'rules/games.tests.json',
      },
    },
  };

  const syncApi = (request: ApiRequest): ApiResponse =>
    request.path === '/sync-schema'
      ? {
          status: 200,
          body: {
            syncId: 's1',
            dryRun: true,
            applied: false,
            prune: false,
            scope: null,
            summary: {
              create: 1,
              update: 0,
              adopt: 0,
              delete: 0,
              noChange: 0,
              error: 0,
            },
            changes: [
              {
                resourceType: 'list',
                list: 'games',
                action: 'create',
                fields: {
                  rules: { from: null, to: RULES },
                },
              },
            ],
            warnings: [],
            blockedBy: null,
          },
        }
      : { status: 404, body: {} };

  test('resolves rule files, checks them, and sends the text', async () => {
    const result = await run({
      args: ['sync-schema', '--dry-run'],
      files: {
        'jsonpad-schema.json': JSON.stringify(document),
        'rules/games.rules': RULES,
        'rules/games.tests.json': JSON.stringify(TESTS),
      },
      api: syncApi,
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /3 passed, 0 failed/);
    const body = result.requests[0]!.body as {
      lists: { games: Record<string, unknown> };
    };
    assert.equal(body.lists.games.rules, RULES);
    assert.deepEqual(body.lists.games.rulesTests, TESTS);
    assert.ok(!('rulesFile' in body.lists.games));
    assert.ok(!('rulesTestsFile' in body.lists.games));
  });

  test('shows a rule change as a diff', async () => {
    const result = await run({
      args: ['sync-schema', '--dry-run'],
      files: {
        'jsonpad-schema.json': JSON.stringify(document),
        'rules/games.rules': RULES,
        'rules/games.tests.json': JSON.stringify(TESTS),
      },
      api: syncApi,
    });

    assert.match(result.stdout, /\+ allow write "writers"/);
  });

  test("doesn't send a document whose rules fail their tests", async () => {
    const failing = structuredClone(TESTS);
    failing.tests[1].expect = 'allow';
    const result = await run({
      args: ['sync-schema'],
      files: {
        'jsonpad-schema.json': JSON.stringify(document),
        'rules/games.rules': RULES,
        'rules/games.tests.json': JSON.stringify(failing),
      },
      api: syncApi,
    });

    assert.equal(result.exitCode, 9);
    assert.deepEqual(result.requests, []);
  });

  test('sends them anyway with --skip-rule-tests', async () => {
    const failing = structuredClone(TESTS);
    failing.tests[1].expect = 'allow';
    const result = await run({
      args: ['sync-schema', '--dry-run', '--skip-rule-tests'],
      files: {
        'jsonpad-schema.json': JSON.stringify(document),
        'rules/games.rules': RULES,
        'rules/games.tests.json': JSON.stringify(failing),
      },
      api: syncApi,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.requests.length, 1);
  });

  test('shows the diagnostics and failing tests the API reports', async () => {
    const result = await run({
      args: ['sync-schema', '--skip-rule-tests'],
      files: {
        'jsonpad-schema.json': JSON.stringify(document),
        'rules/games.rules': RULES,
        'rules/games.tests.json': JSON.stringify(TESTS),
      },
      api: (request: ApiRequest): ApiResponse =>
        request.path === '/sync-schema'
          ? {
              status: 422,
              body: {
                syncId: 's1',
                dryRun: false,
                applied: false,
                prune: false,
                scope: null,
                summary: {
                  create: 0,
                  update: 0,
                  adopt: 0,
                  delete: 0,
                  noChange: 0,
                  error: 1,
                },
                changes: [
                  {
                    resourceType: 'list',
                    list: 'games',
                    action: 'error',
                    errors: [
                      {
                        name: 'WRITE_RULES_INVALID',
                        code: 22003,
                        message:
                          'Write rules are invalid: 1:15 unknown name "identty"',
                        details: {
                          diagnostics: [
                            {
                              severity: 'error',
                              code: 'unknown-name',
                              message: 'unknown name "identty"',
                              span: { line: 1, column: 15 },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
                warnings: [],
                blockedBy: {
                  name: 'SCHEMA_SYNC_PLAN_HAS_ERRORS',
                  code: 21002,
                  message: 'Schema sync not applied: 1 resource has errors',
                },
              },
            }
          : { status: 404, body: {} },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /rules:1:15 unknown name "identty"/);
  });
});

describe('export-schema --split-rules', () => {
  test('writes the rules to their own files and references them', async () => {
    const result = await run({
      args: [
        'export-schema',
        '--out',
        'jsonpad-schema.json',
        '--split-rules',
        'rules',
      ],
      outputs: [
        'jsonpad-schema.json',
        'rules/games.rules',
        'rules/games.tests.json',
      ],
      api: (request: ApiRequest): ApiResponse =>
        request.path === '/sync-schema'
          ? {
              status: 200,
              body: {
                document: {
                  $schema: 'https://jsonpad.io/schema/sync-v1.json',
                  lists: {
                    games: {
                      name: 'Games',
                      rules: RULES.split('\n'),
                      rulesTests: TESTS,
                      indexes: {},
                    },
                  },
                },
                warnings: [],
              },
            }
          : { status: 404, body: {} },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.files['rules/games.rules'], `${RULES}\n`);
    assert.deepEqual(
      JSON.parse(result.files['rules/games.tests.json']!),
      TESTS
    );

    const document = JSON.parse(result.files['jsonpad-schema.json']!);
    assert.deepEqual(document.lists.games, {
      name: 'Games',
      indexes: {},
      rulesFile: 'rules/games.rules',
      rulesTestsFile: 'rules/games.tests.json',
    });
  });

  test('needs --out', async () => {
    const result = await run({
      args: ['export-schema', '--split-rules', 'rules'],
      api: (request: ApiRequest): ApiResponse =>
        request.path === '/sync-schema'
          ? { status: 200, body: { document: { lists: {} }, warnings: [] } }
          : { status: 404, body: {} },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--split-rules needs --out/);
  });
});
