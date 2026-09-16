import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Command } from 'commander';
import {
  addOutputOptions,
  formatBytes,
  printPage,
  printRecord,
  printRecords,
  renderDetails,
  renderTable,
  resolveOutputFormat,
  type RecordsOutput,
} from '../src/output.ts';
import { createTestContext } from './helpers.ts';

type Recipe = { id: string; name: string; createdAt: Date };

const recipes: Recipe[] = [
  { id: 'r1', name: 'Pancakes', createdAt: new Date('2026-09-01T00:00:00Z') },
  { id: 'r2', name: 'Waffles', createdAt: new Date('2026-09-02T00:00:00Z') },
];

const output: RecordsOutput<Recipe> = {
  id: recipe => recipe.id,
  columns: [
    { header: 'ID', value: recipe => recipe.id },
    { header: 'NAME', value: recipe => recipe.name },
  ],
  empty: 'No recipes',
};

describe('resolveOutputFormat', () => {
  test('defaults to a table in a terminal, and JSON otherwise', () => {
    assert.equal(
      resolveOutputFormat(createTestContext({ isTTY: true }), {}),
      'table'
    );
    assert.equal(
      resolveOutputFormat(createTestContext({ isTTY: false }), {}),
      'json'
    );
  });

  test('--output, --json and --quiet choose a format', () => {
    const context = createTestContext({ isTTY: true });

    assert.equal(resolveOutputFormat(context, { output: 'ndjson' }), 'ndjson');
    assert.equal(resolveOutputFormat(context, { json: true }), 'json');
    assert.equal(resolveOutputFormat(context, { quiet: true }), 'id');
    assert.equal(
      resolveOutputFormat(context, { output: 'json', json: true }),
      'json'
    );
  });

  test('refuses formats that disagree', () => {
    assert.throws(
      () =>
        resolveOutputFormat(createTestContext(), { json: true, quiet: true }),
      /disagree/
    );
  });

  test('--output only accepts known formats', () => {
    const command = addOutputOptions(new Command('test'))
      .exitOverride()
      .configureOutput({ writeErr: () => {} })
      .action(() => {});

    assert.throws(
      () => command.parse(['--output', 'yaml'], { from: 'user' }),
      /Allowed choices are table, json, ndjson, id/
    );
  });
});

test('renderTable lines up columns, ignoring colour codes, and truncates long cells', () => {
  const context = createTestContext({ isTTY: true });
  const table = renderTable(
    context,
    [
      {
        header: 'ID',
        value: (row: { id: string; note: string }) =>
          context.colours.bold(row.id),
      },
      { header: 'NOTE', value: row => row.note },
    ],
    [
      { id: 'a', note: 'short' },
      { id: 'abcdef', note: 'x'.repeat(100) },
    ]
  );
  const plain = table.replace(/\x1b\[[0-9;]*m/g, '');

  assert.deepEqual(plain.split('\n'), [
    'ID      NOTE',
    'a       short',
    `abcdef  ${'x'.repeat(59)}…`,
  ]);
});

test('renderDetails lines up values', () => {
  assert.equal(
    renderDetails([
      ['Token', 'Deploy'],
      ['Rate limit', '60 per minute'],
      ['', 'allow *'],
    ]),
    'Token       Deploy\nRate limit  60 per minute\n            allow *'
  );
});

describe('printRecord', () => {
  const record = recipes[0];
  const recordOutput = {
    id: (recipe: Recipe) => recipe.id,
    details: (recipe: Recipe): [string, string][] => [['Name', recipe.name]],
  };

  test('in every format', () => {
    const cases = {
      table: 'Name  Pancakes\n',
      json: `${JSON.stringify(record, null, 2)}\n`,
      ndjson:
        '{"id":"r1","name":"Pancakes","createdAt":"2026-09-01T00:00:00.000Z"}\n',
      id: 'r1\n',
    } as const;

    for (const [format, expected] of Object.entries(cases)) {
      const context = createTestContext();
      printRecord(context, format as keyof typeof cases, record, recordOutput);
      assert.equal(context.output.stdout, expected, format);
    }
  });
});

describe('printRecords', () => {
  test('in every format', () => {
    const cases = {
      table: 'ID  NAME\nr1  Pancakes\nr2  Waffles\n',
      json: `${JSON.stringify(recipes, null, 2)}\n`,
      ndjson: recipes.map(recipe => `${JSON.stringify(recipe)}\n`).join(''),
      id: 'r1\nr2\n',
    } as const;

    for (const [format, expected] of Object.entries(cases)) {
      const context = createTestContext();
      printRecords(context, format as keyof typeof cases, recipes, output);
      assert.equal(context.output.stdout, expected, format);
    }
  });

  test('an empty table is described on stderr, and empty JSON is []', () => {
    const table = createTestContext();
    printRecords(table, 'table', [], output);
    assert.equal(table.output.stdout, '');
    assert.equal(table.output.stderr, 'No recipes\n');

    const json = createTestContext();
    printRecords(json, 'json', [], output);
    assert.equal(json.output.stdout, '[]\n');
  });
});

describe('printPage', () => {
  const page = { page: 2, limit: 2, total: 5, data: recipes };

  test('JSON keeps the page details', () => {
    const context = createTestContext();
    printPage(context, 'json', page, output);

    assert.deepEqual(
      JSON.parse(context.output.stdout),
      JSON.parse(JSON.stringify(page))
    );
  });

  test('a table describes the page on stderr', () => {
    const context = createTestContext();
    printPage(context, 'table', page, output);

    assert.equal(
      context.output.stdout,
      'ID  NAME\nr1  Pancakes\nr2  Waffles\n'
    );
    assert.equal(context.output.stderr, 'page 2 of 3 (5 total)\n');
  });

  test('ids and NDJSON are just the records', () => {
    const context = createTestContext();
    printPage(context, 'id', page, output);

    assert.equal(context.output.stdout, 'r1\nr2\n');
    assert.equal(context.output.stderr, '');
  });
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(10 * 1024 ** 2), '10.0 MB');
});
