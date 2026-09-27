/**
 * The flows commands, and the flow files schema sync resolves
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

const FLOW = {
  version: 1,
  name: 'greet',
  entry: { type: 'endpoint', path: 'greet' },
  nodes: [
    {
      id: 'named',
      type: 'require',
      when: 'input.name != null',
      status: 400,
      message: 'give a name',
    },
    { id: 'out', type: 'respond', body: '{ hello: input.name }' },
  ],
  edges: [['named', 'out']],
};

const TESTS = {
  tests: [
    {
      name: 'greets',
      input: { name: 'Ann' },
      expect: { status: 200, body: { hello: 'Ann' } },
    },
    {
      name: 'needs a name',
      input: {},
      expect: { status: 400, error: 'give a name' },
    },
  ],
};

function run(scenario: Omit<Scenario, 'name'>) {
  return runScenario(CLI_BIN, { name: 'test', ...scenario });
}

describe('flows check', () => {
  test('checks a flow that compiles', async () => {
    const result = await run({
      args: ['flows', 'check', 'greet.flow.json'],
      files: { 'greet.flow.json': JSON.stringify(FLOW) },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /greet\.flow\.json compiles/);
    assert.equal(result.requests.length, 0);
  });

  test("shows where a flow that doesn't compile is wrong", async () => {
    const broken = structuredClone(FLOW);
    broken.nodes[1]!.body = '{ hello: steps.nowhere }';
    const result = await run({
      args: ['flows', 'check', 'greet.flow.json'],
      files: { 'greet.flow.json': JSON.stringify(broken) },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /greet\.flow\.json:\/nodes\/1\/body/);
    assert.match(result.stderr, /greet\.flow\.json has 1 error/);
  });
});

describe('flows test', () => {
  test("runs a flow's tests from the file next to it", async () => {
    const result = await run({
      args: ['flows', 'test', 'greet.flow.json'],
      files: {
        'greet.flow.json': JSON.stringify(FLOW),
        'greet.tests.json': JSON.stringify(TESTS),
      },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /✓ greets/);
    assert.match(result.stdout, /2 passed, 0 failed/);
  });

  test('exits with 9 when a test fails, saying why', async () => {
    const failing = structuredClone(TESTS);
    failing.tests[0]!.expect.body = { hello: 'Bob' };
    const result = await run({
      args: ['flows', 'test', 'greet.flow.json', 'other.json', '--trace'],
      files: {
        'greet.flow.json': JSON.stringify(FLOW),
        'other.json': JSON.stringify(failing),
      },
    });

    assert.equal(result.exitCode, 9);
    assert.match(result.stdout, /✗ greets/);
    assert.match(result.stdout, /out respond: ran/);
    assert.match(result.stderr, /1 of 2 tests failed/);
  });
});

describe('flows run', () => {
  test('calls an endpoint flow and prints what it responded', async () => {
    const result = await run({
      args: ['flows', 'run', 'greet', '--input', '{"name":"Ann"}'],
      api: request =>
        request.method === 'POST' && request.path === '/flows/greet'
          ? {
              status: 200,
              body: { hello: (request.body as { name: string }).name },
              headers: { 'x-flow-run': 'run-1' },
            }
          : { status: 404, body: {} },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { hello: 'Ann' });
    assert.match(result.stderr, /200 \(run run-1\)/);
  });

  test('sends GET input as query parameters, and public flows without a token', async () => {
    const seen: ApiRequest[] = [];
    const api = (request: ApiRequest): ApiResponse => {
      seen.push(request);
      return { status: 204 };
    };

    await run({
      args: [
        'flows',
        'run',
        'scores',
        '--method',
        'get',
        '--input',
        '{"top":3}',
      ],
      api,
    });
    const publicRun = await run({
      args: ['flows', 'run', 'f1', '--public', '--json'],
      recordTokens: true,
      api,
    });

    assert.equal(seen[0]!.method, 'GET');
    assert.deepEqual(seen[0]!.query, { top: ['3'] });
    assert.equal(seen[1]!.path, '/flows/public/f1');
    assert.equal(seen[1]!.token, null);
    assert.deepEqual(JSON.parse(publicRun.stdout), {
      status: 204,
      body: null,
      runId: null,
    });
  });

  test("exits with 10 when the flow fails, with the flow's message", async () => {
    const result = await run({
      args: ['flows', 'run', 'deal-card'],
      api: () => ({
        status: 403,
        body: {
          name: 'FLOW_FAILED',
          code: 23008,
          message: 'not your turn',
          details: { code: 'REQUIRE_FAILED', node: 'your_turn' },
        },
        headers: { 'x-flow-run': 'run-2' },
      }),
    });

    assert.equal(result.exitCode, 10);
    assert.match(
      result.stderr,
      /The flow failed \(403\): not your turn at node "your_turn" \[REQUIRE_FAILED\]/
    );
    assert.match(result.stderr, /Run run-2/);
  });
});

describe('schema sync with flow files', () => {
  const document = {
    lists: {},
    flows: {
      greet: {
        flowFile: 'flows/greet.flow.json',
        flowTestsFile: 'flows/greet.tests.json',
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
                resourceType: 'flow',
                flow: 'greet',
                action: 'create',
                fields: {
                  entry: { from: null, to: 'POST /flows/greet' },
                },
              },
            ],
            blockedBy: null,
          },
        }
      : { status: 404, body: {} };

  test('resolves flow files, tests them, and sends the flow', async () => {
    const result = await run({
      args: ['sync-schema', '--dry-run'],
      files: {
        'jsonpad-schema.json': JSON.stringify(document),
        'flows/greet.flow.json': JSON.stringify(FLOW),
        'flows/greet.tests.json': JSON.stringify(TESTS),
      },
      api: syncApi,
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /2 passed, 0 failed/);
    assert.match(result.stdout, /\+ flow greet create/);
    assert.match(result.stdout, /entry: "?POST \/flows\/greet"?/);
    const body = result.requests[0]!.body as {
      flows: { greet: Record<string, unknown> };
    };
    assert.deepEqual(body.flows.greet.document, FLOW);
    assert.deepEqual(body.flows.greet.tests, TESTS);
    assert.ok(!('flowFile' in body.flows.greet));
  });

  test("doesn't send a document whose flows fail their tests", async () => {
    const failing = structuredClone(TESTS);
    failing.tests[1]!.expect.status = 200;
    const result = await run({
      args: ['sync-schema'],
      files: {
        'jsonpad-schema.json': JSON.stringify(document),
        'flows/greet.flow.json': JSON.stringify(FLOW),
        'flows/greet.tests.json': JSON.stringify(failing),
      },
      api: syncApi,
    });

    assert.equal(result.exitCode, 9);
    assert.equal(result.requests.length, 0);
  });

  test('export-schema --split-flows writes each flow to its own files', async () => {
    const result = await run({
      args: [
        'export-schema',
        '--out',
        'jsonpad-schema.json',
        '--split-flows',
        'flows',
      ],
      outputs: [
        'jsonpad-schema.json',
        'flows/greet.flow.json',
        'flows/greet.tests.json',
      ],
      api: () => ({
        status: 200,
        body: {
          document: {
            lists: {},
            flows: { greet: { document: FLOW, tests: TESTS, activated: true } },
          },
          warnings: [],
        },
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.files['jsonpad-schema.json']!), {
      lists: {},
      flows: {
        greet: {
          activated: true,
          flowFile: 'flows/greet.flow.json',
          flowTestsFile: 'flows/greet.tests.json',
        },
      },
    });
    assert.deepEqual(JSON.parse(result.files['flows/greet.flow.json']!), FLOW);
  });
});
