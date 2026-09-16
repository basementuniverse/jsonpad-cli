/**
 * End-to-end tests for the lists, indexes, items and identities commands,
 * running the built CLI against a fake API
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

const LIST = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  ...TIMESTAMPS,
  name: 'Recipes',
  description: '',
  tags: ['cookbook'],
  pathName: 'recipes',
  schema: null,
  pinned: true,
  readonly: false,
  realtime: true,
  protected: false,
  indexable: true,
  generative: false,
  generativePrompt: '',
  activated: true,
  itemCount: 42,
};

const INDEX = {
  id: 'bbbbbbbb-0000-4000-8000-000000000001',
  ...TIMESTAMPS,
  name: 'Title',
  description: '',
  tags: [],
  pathName: 'title',
  pointer: '/title',
  valueType: 'string',
  alias: true,
  sorting: true,
  filtering: true,
  searching: false,
  guard: false,
  defaultOrderDirection: 'asc',
  activated: true,
  buildStatus: 'ready',
};

const ITEM = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  ...TIMESTAMPS,
  data: { title: 'Pancakes', ingredients: ['flour', 'eggs'] },
  description: 'Fluffy',
  tags: [],
  version: '3',
  readonly: false,
  activated: true,
  size: 64,
  identity: null,
};

const IDENTITY = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  ...TIMESTAMPS,
  name: 'ada',
  displayName: 'Ada',
  tags: [],
  group: 'staff',
  lastLoginAt: null,
  activated: true,
};

const page = (data: unknown[], extra = {}) => ({
  page: 1,
  limit: 20,
  total: data.length,
  data,
  ...extra,
});

const notFound = (message = 'List not found'): ApiResponse => ({
  status: 404,
  body: { name: 'REQUESTED_ENTITY_NOT_FOUND', code: 10004, message },
});

type Routes = Record<
  string,
  (request: ApiRequest, count: number) => ApiResponse
>;

/**
 * Respond by method and path, e.g. 'GET /lists'
 */
const routes =
  (table: Routes) =>
  (request: ApiRequest, count: number): ApiResponse =>
    table[`${request.method} ${request.path}`]?.(request, count) ??
    notFound(`No route for ${request.method} ${request.path}`);

const ok = (body: unknown) => () => ({ status: 200, body });

function run(scenario: Omit<Scenario, 'name'>) {
  return runScenario(CLI_BIN, { name: 'test', ...scenario });
}

const described = (requests: ApiRequest[]) =>
  requests.map(({ method, path, query, body }) => ({
    method,
    path,
    query,
    body,
  }));

describe('lists', { concurrency: 8 }, () => {
  test('list passes filters and paging, and outputs the page as JSON', async () => {
    const result = await run({
      args: [
        'lists',
        '--name',
        'rec',
        '--tagged',
        'a,b',
        '--tagged',
        'c',
        '--pinned',
        '--no-realtime',
        '--page',
        '2',
        '--limit',
        '5',
        '--order',
        'pathName',
        '--direction',
        'desc',
      ],
      api: routes({ 'GET /lists': ok(page([LIST])) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(described(result.requests), [
      {
        method: 'GET',
        path: '/lists',
        query: {
          page: ['2'],
          limit: ['5'],
          order: ['pathName'],
          direction: ['desc'],
          name: ['rec'],
          tagged: ['a,b', 'c'],
          pinned: ['true'],
          realtime: ['false'],
        },
        body: null,
      },
    ]);
    assert.deepEqual(JSON.parse(result.stdout), page([LIST]));
  });

  test('list as a table describes the page on stderr', async () => {
    const result = await run({
      args: ['lists', 'ls', '-o', 'table'],
      api: routes({
        'GET /lists': ok(page([LIST], { page: 1, limit: 1, total: 3 })),
      }),
    });

    assert.equal(
      result.stdout,
      [
        'ID                                    PATH NAME  NAME     ITEMS  FLAGS                        UPDATED',
        `${LIST.id}  recipes    Recipes  42     pinned, realtime, indexable  2026-09-02 11:30Z`,
        '',
      ].join('\n')
    );
    assert.equal(result.stderr, 'page 1 of 3 (3 total)\n');
  });

  test('list validates --limit and --order before sending anything', async () => {
    for (const args of [
      ['lists', '--limit', '101'],
      ['lists', '--page', '0'],
      ['lists', '--order', 'colour'],
    ]) {
      const result = await run({ args });

      assert.equal(result.exitCode, 1, args.join(' '));
      assert.deepEqual(result.requests, []);
    }
  });

  test('get outputs a list, or exits with 6 if there is none', async () => {
    const table = await run({
      args: ['lists', 'get', 'recipes', '-o', 'table'],
      api: routes({ 'GET /lists/recipes': ok(LIST) }),
    });
    assert.equal(
      table.stdout,
      [
        `ID           ${LIST.id}`,
        'Path name    recipes',
        'Name         Recipes',
        'Description  (none)',
        'Tags         cookbook',
        'Items        42',
        'Flags        pinned, realtime, indexable',
        'Schema       (none)',
        'Created      2026-09-01 10:00Z',
        'Updated      2026-09-02 11:30Z',
        '',
      ].join('\n')
    );

    const missing = await run({
      args: ['lists', 'get', 'nope'],
      api: routes({}),
    });
    assert.equal(missing.exitCode, 6);
    assert.equal(missing.stderr, 'No route for GET /lists/nope\n');
  });

  test('create combines --data with options, which take precedence', async () => {
    const result = await run({
      args: [
        'lists',
        'create',
        '--data',
        '@list.json',
        '--name',
        'Recipes',
        '--tags',
        'a, b',
        '--tags',
        'c',
        '--schema',
        '@schema.json',
        '--realtime',
        '--no-protected',
        '-q',
      ],
      files: {
        'list.json': JSON.stringify({ name: 'Old', pathName: 'recipes' }),
        'schema.json': JSON.stringify({ type: 'object' }),
      },
      api: routes({ 'POST /lists': ok(LIST) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].body, {
      name: 'Recipes',
      pathName: 'recipes',
      tags: ['a', 'b', 'c'],
      schema: { type: 'object' },
      realtime: true,
      protected: false,
    });
    assert.equal(result.stdout, `${LIST.id}\n`);
  });

  test('create refuses --data that is not an object', async () => {
    const result = await run({ args: ['lists', 'create', '--data', '[1]'] });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, '--data must be a JSON object\n');
    assert.deepEqual(result.requests, []);
  });

  test('update can remove the schema and prompt, and clear tags', async () => {
    const result = await run({
      args: [
        'lists',
        'update',
        'recipes',
        '--no-schema',
        '--no-generative-prompt',
        '--no-pinned',
        '--tags',
        '',
      ],
      api: routes({ 'PUT /lists/recipes': ok(LIST) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].body, {
      tags: [],
      schema: null,
      generativePrompt: null,
      pinned: false,
    });
  });

  test("delete refuses without --yes when it can't ask, and sends nothing", async () => {
    const result = await run({ args: ['lists', 'delete', 'recipes'] });

    assert.equal(result.exitCode, 5);
    assert.equal(
      result.stderr,
      'Delete the list recipes? Run again with --yes to confirm\n'
    );
    assert.deepEqual(result.requests, []);
  });

  test('delete --yes deletes the list', async () => {
    const result = await run({
      args: ['lists', 'rm', 'recipes', '--yes'],
      api: routes({ 'DELETE /lists/recipes': () => ({ status: 204 }) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      result.requests.map(request => `${request.method} ${request.path}`),
      ['DELETE /lists/recipes']
    );
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'Deleted the list recipes. Its items and indexes are being deleted in the background\n'
    );
  });
});

describe('indexes', { concurrency: 8 }, () => {
  test('list is the default, and passes filters', async () => {
    const result = await run({
      args: [
        'indexes',
        'recipes',
        '--value-type',
        'string',
        '--no-guard',
        '-q',
      ],
      api: routes({ 'GET /lists/recipes/indexes': ok(page([INDEX])) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, {
      valueType: ['string'],
      guard: ['false'],
    });
    assert.equal(result.stdout, `${INDEX.id}\n`);
  });

  test('create --wait waits for the build, and outputs the built index', async () => {
    const result = await run({
      args: [
        'indexes',
        'create',
        'recipes',
        '--path-name',
        'title',
        '--pointer',
        '/title',
        '--value-type',
        'string',
        '--alias',
        '--wait',
      ],
      api: routes({
        'POST /lists/recipes/indexes': ok({
          ...INDEX,
          buildStatus: 'building',
        }),
        'GET /lists/recipes/indexes/title': ok(INDEX),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].body, {
      pathName: 'title',
      pointer: '/title',
      valueType: 'string',
      alias: true,
    });
    assert.equal(
      result.stderr,
      'Waiting for index recipes/title to build... ready\n'
    );
    assert.equal(JSON.parse(result.stdout).buildStatus, 'ready');
  });

  test('create --wait exits with 3 when the build fails', async () => {
    const result = await run({
      args: ['indexes', 'create', 'recipes', '--pointer', '/title', '--wait'],
      api: routes({
        'POST /lists/recipes/indexes': ok({
          ...INDEX,
          buildStatus: 'building',
        }),
        'GET /lists/recipes/indexes/title': ok({
          ...INDEX,
          buildStatus: 'failed',
        }),
      }),
    });

    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      "Waiting for index recipes/title to build... failed\nThe index didn't build. Fix the problem, then run jsonpad indexes rebuild recipes title\n"
    );
  });

  test("update doesn't wait unless asked to", async () => {
    const result = await run({
      args: [
        'indexes',
        'update',
        'recipes',
        'title',
        '--pointer',
        '/name',
        '--no-alias',
      ],
      api: routes({
        'PUT /lists/recipes/indexes/title': ok({
          ...INDEX,
          buildStatus: 'building',
        }),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(result.requests[0].body, {
      pointer: '/name',
      alias: false,
    });
  });

  test('wait exits with 3 when the build takes too long', async () => {
    const result = await run({
      args: ['indexes', 'wait', 'recipes', 'title', '--timeout', '0.1'],
      api: routes({
        'GET /lists/recipes/indexes/title': ok({
          ...INDEX,
          buildStatus: 'building',
        }),
      }),
    });

    assert.equal(result.exitCode, 3);
    assert.match(
      result.stderr,
      /timed out\nThe index didn't finish building in time/
    );
  });

  test('wait for an index that does not exist exits with 6', async () => {
    const result = await run({
      args: ['indexes', 'wait', 'recipes', 'nope'],
      api: routes({}),
    });

    assert.equal(result.exitCode, 6);
  });

  test('delete needs --yes', async () => {
    const refused = await run({
      args: ['indexes', 'delete', 'recipes', 'title'],
    });
    assert.equal(refused.exitCode, 5);
    assert.deepEqual(refused.requests, []);

    const deleted = await run({
      args: ['indexes', 'delete', 'recipes', 'title', '-y'],
      api: routes({
        'DELETE /lists/recipes/indexes/title': () => ({ status: 204 }),
      }),
    });
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    assert.equal(deleted.stderr, 'Deleted the index recipes/title\n');
  });
});

describe('items', { concurrency: 8 }, () => {
  test('list passes index filters, ordering and data options', async () => {
    const result = await run({
      args: [
        'items',
        'recipes',
        '--where',
        'title=Pancakes',
        '--where',
        'servings=4',
        '--order',
        'title',
        '--include-data',
        '--path',
        '$.title',
        '--tagged',
        'breakfast',
      ],
      api: routes({ 'GET /lists/recipes/items': ok(page([ITEM])) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, {
      title: ['Pancakes'],
      servings: ['4'],
      order: ['title'],
      tagged: ['breakfast'],
      includeData: ['true'],
      path: ['$.title'],
    });
  });

  test('list refuses a --where without a value', async () => {
    const result = await run({
      args: ['items', 'recipes', '--where', 'title'],
    });

    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /--where must be an index path name and a value/
    );
    assert.deepEqual(result.requests, []);
  });

  test('get includes the data in a table, and can leave it out', async () => {
    const table = await run({
      args: [
        'items',
        'get',
        'recipes',
        'pancakes',
        '-o',
        'table',
        '--item-version',
        '2',
      ],
      api: routes({ 'GET /lists/recipes/items/pancakes': ok(ITEM) }),
    });

    assert.equal(table.exitCode, 0, table.stderr);
    assert.deepEqual(table.requests[0].query, { version: ['2'] });
    assert.match(
      table.stdout,
      /\nData         \{\n               "title": "Pancakes",\n               "ingredients": \[\n/
    );

    const noData = await run({
      args: ['items', 'get', 'recipes', 'pancakes', '--no-data'],
      api: routes({ 'GET /lists/recipes/items/pancakes': ok(ITEM) }),
    });
    assert.deepEqual(noData.requests[0].query, { includeData: ['false'] });
  });

  test('create reads data from stdin, and needs data', async () => {
    const created = await run({
      args: [
        'items',
        'create',
        'recipes',
        '--data',
        '-',
        '--tags',
        'breakfast',
      ],
      stdin: '{"title":"Waffles"}',
      api: routes({ 'POST /lists/recipes/items': ok(ITEM) }),
    });
    assert.equal(created.exitCode, 0, created.stderr);
    assert.deepEqual(created.requests[0].body, {
      data: { title: 'Waffles' },
      tags: ['breakfast'],
    });

    const noData = await run({ args: ['items', 'create', 'recipes'] });
    assert.equal(noData.exitCode, 1);
    assert.match(noData.stderr, /Pass the item's data with --data/);
  });

  test('create --generate generates the data', async () => {
    const result = await run({
      args: ['items', 'create', 'recipes', '--generate'],
      api: routes({ 'POST /lists/recipes/items': ok(ITEM) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, { generate: ['true'] });
    assert.deepEqual(result.requests[0].body, {});
  });

  test('update and delete', async () => {
    const updated = await run({
      args: [
        'items',
        'update',
        'recipes',
        'pancakes',
        '--data',
        '{"title":"Crêpes"}',
        '--readonly',
      ],
      api: routes({ 'PUT /lists/recipes/items/pancakes': ok(ITEM) }),
    });
    assert.equal(updated.exitCode, 0, updated.stderr);
    assert.deepEqual(updated.requests[0].body, {
      data: { title: 'Crêpes' },
      readonly: true,
    });

    const refused = await run({
      args: ['items', 'delete', 'recipes', 'pancakes'],
    });
    assert.equal(refused.exitCode, 5);

    const deleted = await run({
      args: ['items', 'delete', 'recipes', 'pancakes', '--yes'],
      api: routes({
        'DELETE /lists/recipes/items/pancakes': () => ({ status: 204 }),
      }),
    });
    assert.equal(deleted.exitCode, 0, deleted.stderr);
  });

  test('data get outputs raw JSON for an item, or part of it, even as a table would be the default', async () => {
    const result = await run({
      args: ['items', 'data', 'get', 'recipes', 'pancakes', '/ingredients'],
      api: routes({
        'GET /lists/recipes/items/pancakes/data/ingredients': ok([
          'flour',
          'eggs',
        ]),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, '[\n  "flour",\n  "eggs"\n]\n');
  });

  test('data get without an item outputs a page of data, one per line with ndjson', async () => {
    const result = await run({
      args: [
        'items',
        'data',
        'get',
        'recipes',
        '-o',
        'ndjson',
        '--where',
        'title=Pancakes',
      ],
      api: routes({
        'GET /lists/recipes/items/data': ok(
          page([{ title: 'Pancakes' }, { title: 'Pancakes' }])
        ),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, { title: ['Pancakes'] });
    assert.equal(result.stdout, '{"title":"Pancakes"}\n{"title":"Pancakes"}\n');
  });

  test('data set, replace and patch send the data to the pointer', async () => {
    const cases = [
      [['set', '--data', '{"a":1}'], 'POST', { a: 1 }],
      [['replace', '--data', '"x"'], 'PUT', 'x'],
      [
        ['patch', '--patch', '[{"op":"remove","path":"/0"}]'],
        'PATCH',
        [{ op: 'remove', path: '/0' }],
      ],
    ] as const;

    for (const [args, method, body] of cases) {
      const result = await run({
        args: [
          'items',
          'data',
          args[0],
          'recipes',
          'pancakes',
          '/ingredients',
          ...args.slice(1),
        ],
        api: routes({
          [`${method} /lists/recipes/items/pancakes/data/ingredients`]:
            ok(ITEM),
        }),
      });

      assert.equal(result.exitCode, 0, `${args[0]}: ${result.stderr}`);
      assert.deepEqual(result.requests[0].body, body);
      assert.equal(JSON.parse(result.stdout).id, ITEM.id);
    }
  });

  test('data patch needs an array of operations, and set needs --data', async () => {
    const patch = await run({
      args: ['items', 'data', 'patch', 'recipes', 'pancakes', '--patch', '{}'],
    });
    assert.equal(patch.exitCode, 1);
    assert.match(patch.stderr, /--patch must be a JSON patch/);

    const set = await run({
      args: ['items', 'data', 'set', 'recipes', 'pancakes'],
    });
    assert.equal(set.exitCode, 1);
    assert.match(set.stderr, /required option '--data <json>' not specified/);
  });

  test('data delete needs a pointer and --yes', async () => {
    const root = await run({
      args: ['items', 'data', 'delete', 'recipes', 'pancakes', '/', '--yes'],
    });
    assert.equal(root.exitCode, 1);
    assert.match(root.stderr, /use jsonpad items delete/);

    const refused = await run({
      args: [
        'items',
        'data',
        'delete',
        'recipes',
        'pancakes',
        '/ingredients/0',
      ],
    });
    assert.equal(refused.exitCode, 5);

    const deleted = await run({
      args: [
        'items',
        'data',
        'rm',
        'recipes',
        'pancakes',
        '/ingredients/0',
        '-y',
        '-q',
      ],
      api: routes({
        'DELETE /lists/recipes/items/pancakes/data/ingredients/0': ok(ITEM),
      }),
    });
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    assert.equal(deleted.stdout, `${ITEM.id}\n`);
  });
});

describe('identities', { concurrency: 8 }, () => {
  const other = {
    ...IDENTITY,
    id: 'dddddddd-0000-4000-8000-000000000002',
    name: 'adam',
  };
  const ungrouped = {
    ...IDENTITY,
    id: 'dddddddd-0000-4000-8000-000000000003',
    group: null,
  };

  test('list passes filters', async () => {
    const result = await run({
      args: ['identities', '--group', 'staff', '--order', 'name', '-q'],
      api: routes({ 'GET /identities': ok(page([IDENTITY])) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, {
      order: ['name'],
      group: ['staff'],
    });
    assert.equal(result.stdout, `${IDENTITY.id}\n`);
  });

  test('get by id makes one request', async () => {
    const result = await run({
      args: ['identities', 'get', IDENTITY.id],
      api: routes({ [`GET /identities/${IDENTITY.id}`]: ok(IDENTITY) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.requests.length, 1);
  });

  test('get by group/name finds the exact match among partial ones', async () => {
    const result = await run({
      args: ['identities', 'get', 'staff/ada', '-q'],
      api: routes({
        'GET /identities': ok(page([other, IDENTITY])),
        [`GET /identities/${IDENTITY.id}`]: ok(IDENTITY),
      }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].query, {
      name: ['ada'],
      group: ['staff'],
      limit: ['100'],
    });
    assert.equal(result.stdout, `${IDENTITY.id}\n`);
  });

  test('a name alone means an identity without a group', async () => {
    const found = await run({
      args: ['identities', 'get', 'ada', '-q'],
      api: routes({
        'GET /identities': ok(page([IDENTITY, ungrouped])),
        [`GET /identities/${ungrouped.id}`]: ok(ungrouped),
      }),
    });
    assert.equal(found.stdout, `${ungrouped.id}\n`);

    const missing = await run({
      args: ['identities', 'get', 'ada'],
      api: routes({ 'GET /identities': ok(page([IDENTITY])) }),
    });
    assert.equal(missing.exitCode, 6);
    assert.match(missing.stderr, /no identity named "ada" without a group/);
  });

  test('create reads the password from stdin or the environment', async () => {
    const fromStdin = await run({
      args: [
        'identities',
        'create',
        '--group',
        'staff',
        '--name',
        'ada',
        '--display-name',
        'Ada',
      ],
      stdin: 'correct horse\n',
      api: routes({ 'POST /identities': ok(IDENTITY) }),
    });
    assert.equal(fromStdin.exitCode, 0, fromStdin.stderr);
    assert.deepEqual(fromStdin.requests[0].body, {
      group: 'staff',
      name: 'ada',
      displayName: 'Ada',
      password: 'correct horse',
    });

    const fromEnv = await run({
      args: ['identities', 'create', '--name', 'ada'],
      env: { JSONPAD_IDENTITY_PASSWORD: 'battery staple' },
      api: routes({ 'POST /identities': ok(IDENTITY) }),
    });
    assert.deepEqual(fromEnv.requests[0].body, {
      name: 'ada',
      password: 'battery staple',
    });
  });

  test('create needs a name and a password', async () => {
    const noName = await run({ args: ['identities', 'create'] });
    assert.equal(noName.exitCode, 1);
    assert.match(noName.stderr, /needs a name/);

    const noPassword = await run({
      args: ['identities', 'create', '--name', 'ada'],
    });
    assert.equal(noPassword.exitCode, 1);
    assert.match(noPassword.stderr, /A password is needed/);
    assert.deepEqual(noPassword.requests, []);
  });

  test('update only changes the password when asked to, and can remove the display name', async () => {
    const result = await run({
      args: [
        'identities',
        'update',
        IDENTITY.id,
        '--no-display-name',
        '--password',
      ],
      stdin: 'new password',
      api: routes({ [`PUT /identities/${IDENTITY.id}`]: ok(IDENTITY) }),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests[0].body, {
      displayName: null,
      password: 'new password',
    });

    const noPassword = await run({
      args: ['identities', 'update', IDENTITY.id, '--name', 'ada2'],
      stdin: 'ignored',
      api: routes({ [`PUT /identities/${IDENTITY.id}`]: ok(IDENTITY) }),
    });
    assert.deepEqual(noPassword.requests[0].body, { name: 'ada2' });
  });

  test('delete refuses without --yes before looking anything up', async () => {
    const refused = await run({ args: ['identities', 'delete', 'staff/ada'] });
    assert.equal(refused.exitCode, 5);
    assert.deepEqual(refused.requests, []);

    const deleted = await run({
      args: ['identities', 'rm', 'staff/ada', '--yes'],
      api: routes({
        'GET /identities': ok(page([IDENTITY])),
        [`DELETE /identities/${IDENTITY.id}`]: () => ({ status: 204 }),
      }),
    });
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    assert.deepEqual(
      deleted.requests.map(request => `${request.method} ${request.path}`),
      ['GET /identities', `DELETE /identities/${IDENTITY.id}`]
    );
  });
});
