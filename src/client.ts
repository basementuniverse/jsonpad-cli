import type { Context } from './context.ts';
import { formatDate, formatNumber } from './output.ts';
import { JSONPadError, type JSONPad, type ResponseMeta } from './sdk.ts';

/**
 * How many times a rate limited request is retried
 */
export const MAX_RETRIES = 5;

/**
 * The longest the CLI waits before retrying a rate limited request. If the API
 * asks for a longer wait, the error is reported instead
 */
export const MAX_RETRY_WAIT_SECONDS = 60;

/**
 * Retries that wait at least this long are mentioned on stderr, so that a long
 * wait doesn't look like the command has hung. Shorter ones happen all the
 * time on plans with a minimum gap between requests, so they're only mentioned
 * with --verbose
 */
export const RETRY_NOTICE_SECONDS = 5;

/**
 * Methods that already handle being rate limited themselves
 */
const NOT_RETRIED = new Set<PropertyKey>(['waitForIndex']);

/**
 * How long to wait before retrying a failed request, in milliseconds, or null
 * if it shouldn't be retried
 *
 * Only rate limit errors are retried. A request refused because the monthly
 * quota has run out is also a 429, but it won't succeed until the quota resets
 */
export function retryDelay(error: unknown, attempt: number): number | null {
  if (
    !(error instanceof JSONPadError) ||
    error.status !== 429 ||
    error.errorName !== 'RATE_LIMIT_EXCEEDED' ||
    attempt >= MAX_RETRIES
  ) {
    return null;
  }

  const seconds = error.retryAfter ?? 2 ** attempt;

  return seconds <= MAX_RETRY_WAIT_SECONDS ? Math.max(seconds, 0) * 1000 : null;
}

/**
 * Wrap a client so that its requests are retried when they're rate limited
 *
 * The API refuses a rate limited request before doing anything, so it's safe
 * to retry any request, including ones that create things
 */
export function createRetryingClient(
  context: Context,
  client: JSONPad
): JSONPad {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);

      if (typeof value !== 'function') {
        return value;
      }
      if (NOT_RETRIED.has(property)) {
        return value.bind(target);
      }

      return (...args: unknown[]) => {
        const result = value.apply(target, args);

        // Only requests are retried, not e.g. addEventListener
        if (!(result instanceof Promise)) {
          return result;
        }

        const attempt = async (
          pending: Promise<unknown>,
          count: number
        ): Promise<unknown> => {
          try {
            return await pending;
          } catch (error) {
            const delay = retryDelay(error, count);
            if (delay === null) {
              throw error;
            }

            if (
              delay >= RETRY_NOTICE_SECONDS * 1000 ||
              context.globalOptions.verbose
            ) {
              context.error(
                context.colours.dim(
                  `Rate limited, retrying in ${formatSeconds(delay)}...`
                )
              );
            }
            await context.sleep(delay);

            return attempt(value.apply(target, args), count + 1);
          }
        };

        return attempt(result, 0);
      };
    },
  });
}

function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1000;

  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

const verboseContexts = new WeakSet<Context>();

/**
 * Log every request and response to stderr, for --verbose
 *
 * The SDK uses the global fetch, so this wraps it. The token is sent in a
 * header, which isn't logged
 */
export function installVerboseFetch(context: Context): void {
  if (verboseContexts.has(context)) {
    return;
  }
  verboseContexts.add(context);

  const { dim } = context.colours;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url =
      input instanceof Request
        ? input.url
        : input.toString().replace(/\?$/, '');
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    const started = Date.now();

    context.error(dim(`> ${method} ${url}`));

    try {
      const response = await originalFetch(input, init);
      const requestId = response.headers.get('x-request-id');

      context.error(
        dim(
          `< ${response.status} ${response.statusText} (${
            Date.now() - started
          }ms${requestId ? `, request ${requestId}` : ''})`
        )
      );

      return response;
    } catch (error) {
      context.error(
        dim(`< failed: ${error instanceof Error ? error.message : error}`)
      );
      throw error;
    }
  };
}

/**
 * Describe the rate limit and quota from a response, for --verbose, or null if
 * the response didn't include them
 */
export function describeLimits(meta: ResponseMeta | null): string | null {
  if (!meta) {
    return null;
  }

  const parts: string[] = [];

  if (meta.rateLimit) {
    parts.push(
      `rate limit ${formatNumber(meta.rateLimit.remaining)}/${formatNumber(
        meta.rateLimit.total
      )} left this minute`
    );
  }

  if (meta.quota) {
    const { total, remaining, resetAt, degraded } = meta.quota;
    const reset = `resets ${formatDate(resetAt)}`;

    parts.push(
      total !== null && remaining !== null
        ? `quota ${formatNumber(remaining)}/${formatNumber(total)} left, ${reset}`
        : `no monthly quota`
    );

    if (degraded) {
      parts.push('degraded (reads are served at the free rate limit)');
    }
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}
