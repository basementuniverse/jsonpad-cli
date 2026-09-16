import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createRetryingClient,
  describeLimits,
  MAX_RETRIES,
  retryDelay,
} from '../src/client.ts';
import { JSONPadError, type JSONPad, type ResponseMeta } from '../src/sdk.ts';
import { createTestContext } from './helpers.ts';

const meta = (overrides: Partial<ResponseMeta> = {}): ResponseMeta => ({
  status: 429,
  requestId: null,
  rateLimit: null,
  quota: null,
  retryAfter: null,
  ...overrides,
});

const rateLimited = (retryAfter: number | null = 1) =>
  new JSONPadError(
    429,
    JSON.stringify({
      name: 'RATE_LIMIT_EXCEEDED',
      code: 10007,
      message: 'Rate limit exceeded',
    }),
    meta({ retryAfter })
  );

const quotaExceeded = () =>
  new JSONPadError(
    429,
    JSON.stringify({
      name: 'QUOTA_EXCEEDED',
      code: 10013,
      message: 'Monthly request quota exceeded',
    }),
    meta({ retryAfter: 1_000_000 })
  );

describe('retryDelay', () => {
  test('retries rate limit errors after the delay the API asks for', () => {
    assert.equal(retryDelay(rateLimited(2), 0), 2000);
  });

  test('backs off when the API gives no delay', () => {
    assert.equal(retryDelay(rateLimited(null), 0), 1000);
    assert.equal(retryDelay(rateLimited(null), 3), 8000);
  });

  test("doesn't retry other errors, an exhausted quota, long waits or too many attempts", () => {
    assert.equal(retryDelay(new Error('fetch failed'), 0), null);
    assert.equal(
      retryDelay(new JSONPadError(500, '{}', meta({ status: 500 })), 0),
      null
    );
    assert.equal(retryDelay(quotaExceeded(), 0), null);
    assert.equal(retryDelay(rateLimited(61), 0), null);
    assert.equal(retryDelay(rateLimited(1), MAX_RETRIES), null);
  });
});

/**
 * A fake client whose fetchList fails with the given errors, then succeeds
 */
function fakeClient(errors: unknown[]) {
  let calls = 0;
  const client = {
    get calls() {
      return calls;
    },
    lastResponse: meta({ status: 200 }),
    async fetchList(id: string) {
      calls++;
      if (errors.length > 0) {
        throw errors.shift();
      }
      return { id };
    },
    async waitForIndex() {
      calls++;
      throw rateLimited();
    },
    addEventListener() {
      return 'not a promise';
    },
  };

  return client;
}

describe('createRetryingClient', () => {
  test('retries a rate limited request until it succeeds, mentioning long waits', async () => {
    const context = createTestContext();
    const fake = fakeClient([rateLimited(1), rateLimited(5)]);
    const client = createRetryingClient(context, fake as unknown as JSONPad);

    assert.deepEqual(await client.fetchList('recipes'), { id: 'recipes' });
    assert.equal(fake.calls, 3);
    assert.deepEqual(context.sleeps, [1000, 5000]);
    assert.equal(context.output.stderr, 'Rate limited, retrying in 5s...\n');
  });

  test('mentions every retry with --verbose', async () => {
    const context = createTestContext();
    context.globalOptions = { verbose: true };
    const fake = fakeClient([rateLimited(1)]);
    const client = createRetryingClient(context, fake as unknown as JSONPad);

    await client.fetchList('recipes');
    assert.equal(context.output.stderr, 'Rate limited, retrying in 1s...\n');
  });

  test('gives up after the last retry, with the last error', async () => {
    const context = createTestContext();
    const errors = Array.from({ length: MAX_RETRIES + 1 }, () =>
      rateLimited(1)
    );
    const last = errors[errors.length - 1];
    const fake = fakeClient(errors);
    const client = createRetryingClient(context, fake as unknown as JSONPad);

    await assert.rejects(client.fetchList('recipes'), error => error === last);
    assert.equal(fake.calls, MAX_RETRIES + 1);
  });

  test("doesn't retry an exhausted quota", async () => {
    const context = createTestContext();
    const fake = fakeClient([quotaExceeded()]);
    const client = createRetryingClient(context, fake as unknown as JSONPad);

    await assert.rejects(client.fetchList('recipes'), { status: 429 });
    assert.equal(fake.calls, 1);
    assert.deepEqual(context.sleeps, []);
  });

  test("leaves waitForIndex, properties and methods that aren't requests alone", async () => {
    const context = createTestContext();
    const fake = fakeClient([]);
    const client = createRetryingClient(context, fake as unknown as JSONPad);

    await assert.rejects((client as any).waitForIndex(), { status: 429 });
    assert.equal(fake.calls, 1);
    assert.equal((client as any).addEventListener(), 'not a promise');
    assert.equal(client.lastResponse!.status, 200);
  });
});

describe('describeLimits', () => {
  test('describes the rate limit and quota', () => {
    assert.equal(
      describeLimits(
        meta({
          status: 200,
          rateLimit: { total: 60, remaining: 58 },
          quota: {
            total: 10000,
            remaining: 8796,
            credits: 0,
            resetAt: new Date('2026-10-01T00:00:00Z'),
            degraded: false,
          },
        })
      ),
      'rate limit 58/60 left this minute · quota 8,796/10,000 left, resets 2026-10-01'
    );
  });

  test('says when reads are degraded, or there is no monthly quota', () => {
    assert.equal(
      describeLimits(
        meta({
          status: 200,
          quota: {
            total: null,
            remaining: null,
            credits: null,
            resetAt: new Date('2026-10-01T00:00:00Z'),
            degraded: true,
          },
        })
      ),
      'no monthly quota · degraded (reads are served at the free rate limit)'
    );
  });

  test('is null without limits', () => {
    assert.equal(describeLimits(null), null);
    assert.equal(describeLimits(meta({ status: 200 })), null);
  });
});
