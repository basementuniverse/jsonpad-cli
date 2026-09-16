import type { Command } from 'commander';
import type { Context } from '../../context.ts';
import { CliError, describeApiError } from '../../errors.ts';
import { formatValue, plural } from '../../output.ts';
import type { MoveListsChange, MoveListsResult } from '../../sdk.ts';

type MoveListsOptions = {
  to?: string;
  release?: boolean;
  fromScope?: string;
  dryRun?: boolean;
  json?: boolean;
};

export function defineMoveLists(command: Command, context: Context): Command {
  return command
    .description(
      'Move lists (by id or path name) to a scope, or release them from their scope'
    )
    .argument('[list...]', 'The lists to move')
    .option('--to <scope>', 'The scope to move the lists to')
    .option('--release', 'Release the lists from their scope instead')
    .option(
      '--from-scope <scope>',
      'Move every list this scope manages, instead of naming lists (e.g. to rename the scope)'
    )
    .option('--dry-run', 'Show what would change, without changing it')
    .option('--json', "Print the API's response as JSON")
    .action((lists: string[], options: MoveListsOptions) =>
      moveLists(context, lists, options)
    );
}

function printMoveChange(context: Context, change: MoveListsChange) {
  const { green, yellow, red, cyan, dim, bold } = context.colours;
  const symbols: Record<MoveListsChange['action'], string> = {
    move: cyan('>'),
    assign: green('+'),
    release: yellow('-'),
    'no-change': dim('='),
    error: red('!'),
  };
  const scopeName = (scope: string | null | undefined) =>
    scope === null ? dim('no scope') : String(scope);

  const action = change.action === 'no-change' ? 'no change' : change.action;
  const scopes =
    change.from !== undefined && change.action !== 'no-change'
      ? ` ${scopeName(change.from)} ${dim('->')} ${scopeName(change.to)}`
      : '';
  const indexes =
    change.indexes !== undefined
      ? dim(` (${plural(change.indexes, 'index', 'indexes')})`)
      : '';

  context.log(
    `${symbols[change.action]} list ${bold(change.list)} ${dim(
      action
    )}${scopes}${indexes}`
  );

  for (const [field, { from, to }] of Object.entries(change.fields || {})) {
    context.log(
      `    ${field}: ${formatValue(from)} ${dim('->')} ${formatValue(to)}`
    );
  }

  for (const warning of change.warnings || []) {
    context.log(`    ${yellow('warning')}: ${warning}`);
  }

  for (const error of change.errors || []) {
    context.log(`    ${red('error')}: ${error.message}`);
  }
}

export async function moveLists(
  context: Context,
  lists: string[],
  options: MoveListsOptions
): Promise<void> {
  const { green, yellow, red, dim, bold } = context.colours;
  const usage =
    'Usage: jsonpad move-lists [list...] (--to <scope> | --release) [--from-scope <scope>]';

  if (!!options.to === !!options.release) {
    throw new CliError(`Pass either --to <scope> or --release. ${usage}`);
  }

  if (lists.length > 0 === !!options.fromScope) {
    throw new CliError(
      `Name the lists to move, or pass --from-scope, but not both. ${usage}`
    );
  }

  const jsonpad = context.createClient();
  const selection = options.fromScope
    ? { fromScope: options.fromScope }
    : { lists };
  let result: MoveListsResult;

  try {
    result = await jsonpad.moveLists(
      selection,
      options.release ? null : options.to!,
      { dryRun: !!options.dryRun }
    );
  } catch (error) {
    throw new CliError(describeApiError(error));
  }

  if (options.json) {
    context.log(JSON.stringify(result, null, 2));
  } else {
    context.log(
      bold(result.dryRun ? 'Move lists plan (dry run)' : 'Move lists') +
        dim(result.scope ? ` to scope ${result.scope}` : ' out of their scope')
    );
    context.log();

    for (const warning of result.warnings) {
      context.log(`${yellow('warning')}: ${warning}`);
    }
    if (result.changes.length === 0 && result.warnings.length === 0) {
      context.log(dim('No lists to move'));
    }
    result.changes.forEach(change => printMoveChange(context, change));

    const { summary } = result;
    const parts = [
      `${summary.move} to move`,
      `${summary.assign} to assign`,
      `${summary.release} to release`,
      `${summary.noChange} unchanged`,
    ];
    if (summary.error > 0) {
      parts.push(red(`${summary.error} with errors`));
    }
    context.log(`\n${parts.join(', ')}`);
  }

  if (result.blockedBy) {
    throw new CliError(
      result.dryRun
        ? `A real move would be refused: ${result.blockedBy.message}`
        : result.blockedBy.message
    );
  }

  if (!options.json) {
    const { move, assign, release } = result.summary;

    if (move + assign + release === 0) {
      context.log(green('Nothing to change'));
    } else {
      context.log(
        result.applied ? green('Applied') : dim('Not applied (dry run)')
      );
    }
  }
}
