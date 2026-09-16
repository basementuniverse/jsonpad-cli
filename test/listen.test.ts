import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { listen, type ListenDependencies } from '../src/commands/listen.ts';
import type { Auth } from '../src/config.ts';
import { CliError } from '../src/errors.ts';
import type { RealtimeClient } from '../src/realtime.ts';
import { JSONPadError } from '../src/sdk.ts';
import { createTestContext } from './helpers.ts';

/**
 * A realtime client that does nothing until the test dispatches events on it
 */
class FakeRealtime extends EventTarget {
  public listened: unknown[] = [];
  public closed = false;

  public listen(...args: unknown[]) {
    this.listened = args;
    queueMicrotask(() => this.dispatchEvent(new Event('connected')));
  }

  public close() {
    this.closed = true;
  }

  public send(type: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  public fail(fields: {
    detail: string;
    errorName?: string | null;
    retryIn?: number | null;
  }) {
    const event = Object.assign(
      new CustomEvent('error', { detail: fields.detail }),
      {
        errorName: fields.errorName ?? null,
        retryIn: fields.retryIn ?? null,
      }
    );
    this.dispatchEvent(event);
  }
}

const LIST = { id: 'list-1', pathName: 'recipes', realtime: true };

function setup(
  options: {
    apiUrl?: string;
    lists?: Record<string, object>;
    isTTY?: boolean;
  } = {}
) {
  const context = createTestContext({ isTTY: options.isTTY });
  const realtime = new FakeRealtime();
  const fetched: string[] = [];
  let interrupt: () => void = () => {};

  context.createClient = () => {
    context.auth = {
      token: 'api-token',
      apiUrl: options.apiUrl ?? 'https://api.jsonpad.io',
      source: { type: 'environment' },
    } satisfies Auth;

    return {
      fetchList: async (id: string) => {
        fetched.push(id);
        const list = (options.lists ?? { recipes: LIST })[id];
        if (!list) {
          throw new JSONPadError(
            404,
            JSON.stringify({
              name: 'REQUESTED_ENTITY_NOT_FOUND',
              code: 1,
              message: 'List not found',
            }),
            {
              status: 404,
              requestId: null,
              rateLimit: null,
              quota: null,
              retryAfter: null,
            }
          );
        }
        return list;
      },
    } as any;
  };

  const dependencies: ListenDependencies = {
    connect: token => {
      assert.equal(token, 'api-token');
      return realtime as unknown as RealtimeClient;
    },
    onInterrupt: stop => {
      interrupt = stop;
      return () => {
        interrupt = () => {};
      };
    },
  };

  return {
    context,
    realtime,
    fetched,
    dependencies,
    interrupt: () => interrupt(),
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('listen', () => {
  test('refuses to run against an API other than the production one', async () => {
    const { context, dependencies } = setup({
      apiUrl: 'http://localhost:8000',
    });

    await assert.rejects(listen(context, [], {}, dependencies), {
      message:
        /only works with https:\/\/api\.jsonpad\.io, not http:\/\/localhost:8000 \(from JSONPAD_API_URL\)/,
    });
  });

  test('outputs events as NDJSON, and stops after --count', async () => {
    const { context, realtime, fetched, dependencies } = setup();
    const listening = listen(
      context,
      ['recipes'],
      { count: 2, events: ['item-created', 'item-deleted'] },
      dependencies
    );

    await tick();
    assert.deepEqual(fetched, ['recipes']);
    assert.deepEqual(realtime.listened, [
      ['item-created', 'item-deleted'],
      ['recipes'],
      undefined,
    ]);

    const model = { id: 'item-1', version: '2', data: { a: 1 } };
    realtime.send('item-created', {
      listId: 'list-1',
      itemId: 'item-1',
      model,
    });
    realtime.send('item-deleted', {
      listId: 'list-1',
      itemId: 'item-1',
      model,
    });
    realtime.send('item-created', {
      listId: 'list-1',
      itemId: 'item-2',
      model,
    });
    await listening;

    const lines = context.output.stdout
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(
      { ...lines[0], receivedAt: undefined },
      {
        type: 'item-created',
        listId: 'list-1',
        itemId: 'item-1',
        model,
        receivedAt: undefined,
      }
    );
    assert.equal(realtime.closed, true);
    assert.match(
      context.output.stderr,
      /Listening for item-created, item-deleted in recipes/
    );
  });

  test('outputs readable lines in a terminal, until Ctrl+C', async () => {
    const { context, realtime, dependencies, interrupt } = setup({
      isTTY: true,
    });
    const listening = listen(context, [], {}, dependencies);

    await tick();
    assert.equal((realtime.listened[0] as string[]).length, 7);
    realtime.send('list-updated', {
      listId: 'list-1',
      model: { id: 'list-1', pathName: 'recipes' },
    });
    interrupt();
    await listening;

    const plain = context.output.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(
      plain,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z {2}list-updated {3}list recipes\n$/
    );
    assert.match(context.output.stderr, /Stopped/);
    assert.equal(realtime.closed, true);
  });

  test('a refused connection ends with an exit code for why', async () => {
    const { context, realtime, dependencies } = setup();
    const listening = listen(context, [], {}, dependencies);

    await tick();
    realtime.fail({
      detail: 'User not authenticated (invalid API token)',
      errorName: 'USER_NOT_AUTHENTICATED',
    });

    await assert.rejects(
      listening,
      (error: unknown) => error instanceof CliError && error.exitCode === 7
    );
    assert.equal(realtime.closed, true);
  });

  test('a refusal the SDK retries is reported, and listening carries on', async () => {
    const { context, realtime, dependencies } = setup();
    const listening = listen(context, [], { count: 1 }, dependencies);

    await tick();
    realtime.fail({
      detail: 'Realtime connection limit exceeded (max: 1)',
      errorName: 'REALTIME_CONNECTION_LIMIT_EXCEEDED',
      retryIn: 46,
    });
    realtime.send('item-created', { model: { id: 'x' } });
    await listening;

    assert.match(
      context.output.stderr,
      /connection limit exceeded \(max: 1\)\. Trying again in 46s/
    );
  });

  test("a list that doesn't exist exits with 6, before connecting", async () => {
    const { context, realtime, dependencies } = setup();

    await assert.rejects(
      listen(context, ['nope'], {}, dependencies),
      (error: unknown) => error instanceof CliError && error.exitCode === 6
    );
    assert.deepEqual(realtime.listened, []);
  });

  test('warns about a list with realtime turned off', async () => {
    const { context, realtime, dependencies } = setup({
      lists: { quiet: { ...LIST, realtime: false } },
    });
    const listening = listen(context, ['quiet'], { count: 1 }, dependencies);

    await tick();
    realtime.send('item-created', { model: { id: 'x' } });
    await listening;

    assert.match(
      context.output.stderr,
      /warning: quiet has realtime turned off, so it won't send events\. Turn it on with: jsonpad lists update quiet --realtime/
    );
  });
});
