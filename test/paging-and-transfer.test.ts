import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { installRequestPacing, requestInterval } from '../src/client.ts';
import { dateOf, renderStats } from '../src/commands/history.ts';
import { parseImport } from '../src/commands/transfer.ts';
import { fetchAll, parseDate, printPages } from '../src/resources.ts';
import { createTestContext } from './helpers.ts';

describe('parseImport', () => {
  test('reads NDJSON items, keeping only the fields an import sets, and skipping blank lines', () => {
    const text = [
      JSON.stringify({
        id: 'old-id',
        createdAt: '2026-01-01',
        data: { title: 'Pancakes' },
        description: 'Fluffy',
        tags: ['breakfast'],
        readonly: true,
        version: '7',
      }),
      '',
      JSON.stringify({ data: [1, 2] }),
      '',
    ].join('\n');

    assert.deepEqual(parseImport(text, false), {
      records: [
        {
          position: 'line 1',
          line: 1,
          body: {
            data: { title: 'Pancakes' },
            description: 'Fluffy',
            tags: ['breakfast'],
            readonly: true,
          },
        },
        { position: 'line 3', line: 3, body: { data: [1, 2] } },
      ],
      errors: [],
    });
  });

  test('reads a JSON array as a list of records', () => {
    const { records, errors } = parseImport(
      '[\n  {"title": "a"},\n  {"title": "b"}\n]',
      true
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(records, [
      { position: 'record 1', line: undefined, body: { data: { title: 'a' } } },
      { position: 'record 2', line: undefined, body: { data: { title: 'b' } } },
    ]);
  });

  test('finds every problem: invalid JSON, and records that are not items', () => {
    const text = ['{"data": 1}', '{nope', '{"title": "no data"}', '[1]'].join(
      '\n'
    );
    const { records, errors } = parseImport(text, false);

    assert.equal(records.length, 1);
    assert.equal(errors.length, 3);
    assert.match(errors[0], /^line 2: isn't valid JSON/);
    assert.match(errors[1], /^line 3: isn't an item .* Use --data-only/);
    assert.match(errors[2], /^line 4: isn't an item/);
  });

  test('with --data-only, any JSON value is an item', () => {
    const { records, errors } = parseImport('1\n"text"\nnull\n', true);

    assert.deepEqual(errors, []);
    assert.deepEqual(
      records.map(record => record.body),
      [{ data: 1 }, { data: 'text' }, { data: null }]
    );
  });
});

describe('requestInterval', () => {
  test("uses the plan's gap or its requests per minute, whichever is longer", () => {
    assert.equal(
      requestInterval({ rateLimit: 100, maxRequestsPerMinute: 60 }),
      1050
    );
    assert.equal(
      requestInterval({ rateLimit: 2000, maxRequestsPerMinute: 600 }),
      2050
    );
    assert.equal(
      requestInterval({ rateLimit: null, maxRequestsPerMinute: null }),
      0
    );
  });
});

test('installRequestPacing waits between one response and the next request', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls: number[] = [];
  globalThis.fetch = (async () => {
    calls.push(Date.now());
    return new Response('{}');
  }) as typeof fetch;

  const context = createTestContext();
  installRequestPacing(context, 500);

  await fetch('http://example/1');
  await fetch('http://example/2');
  await fetch('http://example/3');

  assert.equal(calls.length, 3);
  // Every request waits, including the first, since pacing is installed just
  // after a request
  assert.equal(context.sleeps.length, 3);
  for (const wait of context.sleeps) {
    assert.ok(wait > 400 && wait <= 500, `waited ${wait}ms`);
  }
});

describe('fetchAll', () => {
  const pages = (total: number) => {
    const requested: number[] = [];
    const fetchPage = async ({
      page,
      limit,
    }: {
      page: number;
      limit: number;
    }) => {
      requested.push(page);
      const start = (page - 1) * limit;

      return {
        page,
        limit,
        total,
        data: Array.from(
          { length: Math.max(0, Math.min(limit, total - start)) },
          (_, i) => start + i
        ),
      };
    };

    return { requested, fetchPage };
  };

  const collect = async <T>(records: AsyncIterable<T>) => {
    const all: T[] = [];
    for await (const record of records) {
      all.push(record);
    }
    return all;
  };

  test('fetches pages of 100 until there are no more', async () => {
    const { requested, fetchPage } = pages(250);
    const all = await collect(fetchAll(createTestContext(), fetchPage));

    assert.equal(all.length, 250);
    assert.deepEqual(requested, [1, 2, 3]);
  });

  test("doesn't fetch an empty page after an exact multiple of 100", async () => {
    const { requested, fetchPage } = pages(200);

    assert.equal(
      (await collect(fetchAll(createTestContext(), fetchPage))).length,
      200
    );
    assert.deepEqual(requested, [1, 2]);
  });

  test('stops at max, without fetching more pages than it needs', async () => {
    const { requested, fetchPage } = pages(1000);
    const all = await collect(fetchAll(createTestContext(), fetchPage, 150));

    assert.equal(all.length, 150);
    assert.deepEqual(requested, [1, 2]);
  });
});

describe('printPages option checks', () => {
  const never = async () => {
    throw new Error('should not fetch');
  };
  const output = { id: () => '', columns: [], empty: '' };

  test('--page and --limit need a single page, and --max needs --all', async () => {
    for (const options of [
      { all: true, page: 2 },
      { all: true, limit: 10 },
      { max: 5 },
    ]) {
      await assert.rejects(
        printPages(createTestContext(), options, never, output),
        /--page and --limit|--max only works with --all/
      );
    }
  });
});

test('parseDate accepts dates and date-times, as ISO 8601', () => {
  assert.equal(parseDate('2026-09-01'), '2026-09-01T00:00:00.000Z');
  assert.equal(parseDate('2026-09-01T12:30:00Z'), '2026-09-01T12:30:00.000Z');
  assert.throws(() => parseDate('last tuesday'), /Must be a date/);
});

test('renderStats summarises each series and tabulates counts by day', () => {
  const stats = {
    maxItems: 1000,
    items: {
      total: 42,
      totalThisPeriod: 5,
      metrics: [
        { date: '2026-09-15T00:00:00.000Z', count: 3, lists: {} },
        { date: '2026-09-16T00:00:00.000Z', count: 2, lists: {} },
      ],
    },
    events: {
      total: 120,
      totalThisPeriod: 7,
      metrics: [
        {
          date: '2026-09-16T00:00:00.000Z',
          count: 7,
          types: { 'item-created': 5, 'item-updated': 2, 'item-deleted': 0 },
        },
      ],
    },
  };

  assert.equal(
    renderStats(createTestContext(), stats, 7),
    [
      'Items   42 (5 in the last 7 days, limit 1,000)',
      'Events  120 (7 in the last 7 days)',
      '',
      'DATE        ITEMS  EVENTS  EVENT TYPES',
      '2026-09-15  3      0       -',
      '2026-09-16  2      7       item-created 5, item-updated 2',
    ].join('\n')
  );
});

test('dateOf uses the UTC date for a UTC midnight, and the local date otherwise', () => {
  assert.equal(dateOf('2026-09-16T00:00:00.000Z'), '2026-09-16');

  // An hour before midnight UTC is a server's midnight in a zone ahead of UTC.
  // It's local midnight when this machine is in that zone too, which is what
  // the local date shows
  const local = new Date(2026, 8, 16);
  if (local.getUTCHours() !== 0) {
    assert.equal(dateOf(local.toISOString()), '2026-09-16');
  }
});
