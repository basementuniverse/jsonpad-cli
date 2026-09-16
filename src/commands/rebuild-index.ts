import type { Command } from 'commander';
import type { Context } from '../context.ts';
import { CliError, describeApiError } from '../errors.ts';
import { parseTimeout, waitForIndexes } from '../indexes.ts';

type RebuildIndexOptions = {
  wait?: boolean;
  timeout?: string;
};

export function defineRebuildIndex(
  command: Command,
  context: Context
): Command {
  return command
    .description(
      'Rebuild an index whose last build failed, once the problem has been fixed'
    )
    .argument('<list>', 'The list (id or path name)')
    .argument('<index>', 'The index (id or path name)')
    .option('--wait', 'Wait for the build to finish')
    .option('--timeout <seconds>', 'How long to wait (default 600)')
    .action((list: string, index: string, options: RebuildIndexOptions) =>
      rebuildIndex(context, list, index, options)
    );
}

export async function rebuildIndex(
  context: Context,
  list: string,
  index: string,
  options: RebuildIndexOptions
): Promise<void> {
  const jsonpad = context.createClient();
  let rebuilt;

  try {
    rebuilt = await jsonpad.rebuildIndex(list, index);
  } catch (error) {
    throw new CliError(describeApiError(error));
  }

  context.log(`Rebuilding index ${context.colours.bold(`${list}/${index}`)}`);

  if (options.wait) {
    await waitForIndexes(
      context,
      jsonpad,
      [{ listId: list, indexId: rebuilt.id, label: `${list}/${index}` }],
      parseTimeout(options.timeout)
    );
  }
}
