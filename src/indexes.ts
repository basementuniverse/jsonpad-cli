import type { Context } from './context.ts';
import {
  apiError,
  CliError,
  describeApiError,
  EXIT_BUILD_FAILED,
} from './errors.ts';
import { IndexBuildError, type Index, type JSONPad } from './sdk.ts';

export type IndexToWaitFor = {
  listId: string;
  indexId: string;
  label: string;
};

/**
 * Parse a --timeout option (in seconds) into milliseconds
 */
export function parseTimeout(value: string | undefined): number {
  if (value === undefined) {
    return 600 * 1000;
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError('--timeout must be a number of seconds');
  }

  return seconds * 1000;
}

export async function waitForIndexes(
  context: Context,
  jsonpad: JSONPad,
  indexes: IndexToWaitFor[],
  timeout: number
): Promise<void> {
  const { green, red } = context.colours;
  let failed = false;

  // Builds for one account run one at a time, so waiting for them in order
  // doesn't slow anything down, and polls less than waiting for all at once
  for (const { listId, indexId, label } of indexes) {
    context.stdout.write(`Waiting for index ${label} to build... `);

    try {
      await jsonpad.waitForIndex(listId, indexId, { timeout });
      context.stdout.write(`${green('ready')}\n`);
    } catch (error) {
      failed = true;

      if (error instanceof IndexBuildError) {
        context.stdout.write(
          `${red(error.reason === 'failed' ? 'failed' : 'timed out')}\n`
        );
      } else {
        context.stdout.write(`${red('error')}: ${describeApiError(error)}\n`);
      }
    }
  }

  if (failed) {
    throw new CliError(
      'One or more indexes did not build. Fix the problem, then run jsonpad rebuild-index <list> <index>',
      EXIT_BUILD_FAILED
    );
  }
}

/**
 * Wait for one index to be built, describing progress on stderr, and return it
 * once it's ready. For the new commands, which keep stdout for data
 */
export async function waitForIndex(
  context: Context,
  jsonpad: JSONPad,
  list: string,
  index: string,
  timeout: number
): Promise<Index> {
  const { green, red } = context.colours;
  context.stderr.write(`Waiting for index ${list}/${index} to build... `);

  try {
    const ready = await jsonpad.waitForIndex(list, index, { timeout });
    context.stderr.write(`${green('ready')}\n`);

    return ready;
  } catch (error) {
    if (error instanceof IndexBuildError) {
      context.stderr.write(
        `${red(error.reason === 'failed' ? 'failed' : 'timed out')}\n`
      );

      throw new CliError(
        error.reason === 'failed'
          ? `The index didn't build. Fix the problem, then run jsonpad indexes rebuild ${list} ${index}`
          : `The index didn't finish building in time. Run jsonpad indexes wait ${list} ${index} to keep waiting`,
        EXIT_BUILD_FAILED
      );
    }

    context.stderr.write(`${red('error')}\n`);
    throw apiError(error, context.auth?.apiUrl);
  }
}
