import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { Context } from '../../context.ts';
import {
  CliError,
  describeApiError,
  EXIT_DESTRUCTIVE_NOT_ALLOWED,
  EXIT_ERROR,
  EXIT_REBUILD_NOT_ALLOWED,
} from '../../errors.ts';
import { parseTimeout, waitForIndexes } from '../../indexes.ts';
import { formatValue, plural } from '../../output.ts';
import type {
  SyncSchemaChange,
  SyncSchemaDocument,
  SyncSchemaResult,
} from '../../sdk.ts';

export const DEFAULT_SCHEMA_FILE = 'jsonpad-schema.json';

type SyncSchemaOptions = {
  dryRun?: boolean;
  allowRebuild?: boolean;
  prune?: boolean;
  allowDestructive?: boolean;
  wait?: boolean;
  timeout?: string;
  showUnchanged?: boolean;
  json?: boolean;
};

export function defineSyncSchema(command: Command, context: Context): Command {
  return command
    .description(
      'Create and update lists and indexes to match a schema document'
    )
    .argument('[file]', 'The schema document', DEFAULT_SCHEMA_FILE)
    .option('--dry-run', 'Show what would change, without changing it')
    .option(
      '--allow-rebuild',
      "Allow changes that rebuild an index in a list with items (the index can't be used until the rebuild finishes)"
    )
    .option(
      '--prune',
      "Also delete the lists and indexes the document's scope manages that it no longer declares"
    )
    .option(
      '--allow-destructive',
      'Allow a prune to delete lists that have items, and guard indexes'
    )
    .option('--wait', 'Wait for index builds to finish')
    .option(
      '--timeout <seconds>',
      'How long --wait waits for each index (default 600)'
    )
    .option('--show-unchanged', "Also list resources that don't change")
    .option('--json', "Print the API's response as JSON")
    .action((file: string, options: SyncSchemaOptions) =>
      syncSchema(context, file, options)
    );
}

function printChange(context: Context, change: SyncSchemaChange) {
  const { green, yellow, red, cyan, dim, bold } = context.colours;
  const symbols: Record<SyncSchemaChange['action'], string> = {
    create: green('+'),
    update: yellow('~'),
    adopt: cyan('@'),
    delete: red('-'),
    'no-change': dim('='),
    error: red('!'),
  };

  const name =
    change.resourceType === 'list'
      ? `list ${bold(change.list)}`
      : `index ${bold(`${change.list}/${change.index}`)}`;
  const action = change.action === 'no-change' ? 'no change' : change.action;
  const build = change.build
    ? dim(
        ` (${change.build.reason === 'created' ? 'build' : 'rebuild'}: ${
          change.build.items
        } ${change.build.items === 1 ? 'item' : 'items'}${
          change.build.requiresConfirmation ? ', needs --allow-rebuild' : ''
        })`
      )
    : '';
  const deleteDetails = change.delete
    ? [
        ...(change.delete.items !== undefined
          ? [plural(change.delete.items, 'item')]
          : []),
        ...(change.delete.indexes !== undefined
          ? [plural(change.delete.indexes, 'index', 'indexes')]
          : []),
        ...(change.delete.destructive ? ['needs --allow-destructive'] : []),
      ]
    : [];
  const deleted =
    deleteDetails.length > 0 ? dim(` (${deleteDetails.join(', ')})`) : '';

  context.log(
    `${symbols[change.action]} ${name} ${dim(action)}${build}${deleted}`
  );

  for (const [field, { from, to }] of Object.entries(change.fields || {})) {
    context.log(
      change.action === 'create'
        ? `    ${field}: ${formatValue(to)}`
        : `    ${field}: ${formatValue(from)} ${dim('->')} ${formatValue(to)}`
    );
  }

  for (const warning of change.warnings || []) {
    context.log(`    ${yellow('warning')}: ${warning}`);
  }

  for (const error of change.errors || []) {
    context.log(`    ${red('error')}: ${error.message}`);
  }
}

function printSummary(context: Context, result: SyncSchemaResult) {
  const { summary } = result;
  const parts = [
    `${summary.create} to create`,
    `${summary.update} to update`,
    `${summary.adopt} to adopt`,
    ...(result.prune ? [`${summary.delete} to delete`] : []),
    `${summary.noChange} unchanged`,
  ];

  if (summary.error > 0) {
    parts.push(context.colours.red(`${summary.error} with errors`));
  }

  context.log(`\n${parts.join(', ')}`);
}

export async function syncSchema(
  context: Context,
  file: string,
  options: SyncSchemaOptions
): Promise<void> {
  const { green, dim, bold } = context.colours;
  let document: SyncSchemaDocument;

  try {
    document = JSON.parse(
      fs.readFileSync(path.resolve(context.cwd, file), 'utf8')
    );
  } catch (error: any) {
    throw new CliError(
      error.code === 'ENOENT'
        ? `Can't find ${file}`
        : `Can't read ${file}: ${error.message}`
    );
  }

  const jsonpad = context.createClient();
  let result: SyncSchemaResult;

  try {
    result = await jsonpad.syncSchema(document, {
      dryRun: !!options.dryRun,
      allowRebuild: !!options.allowRebuild,
      prune: !!options.prune,
      allowDestructive: !!options.allowDestructive,
    });
  } catch (error) {
    throw new CliError(describeApiError(error));
  }

  if (options.json) {
    context.log(JSON.stringify(result, null, 2));
  } else {
    const heading = result.dryRun
      ? 'Schema sync plan (dry run)'
      : 'Schema sync';
    context.log(
      bold(heading) + (result.scope ? dim(` for scope ${result.scope}`) : '')
    );
    context.log();

    // Unchanged resources are hidden unless they have something to say, e.g.
    // an index whose last build failed
    const shown = result.changes.filter(
      change =>
        options.showUnchanged ||
        change.action !== 'no-change' ||
        (change.warnings && change.warnings.length > 0)
    );
    if (shown.length === 0) {
      context.log(dim('Nothing to change'));
    }
    shown.forEach(change => printChange(context, change));

    printSummary(context, result);
  }

  if (result.blockedBy) {
    // The API's message names the query parameter, not the CLI option
    const flags: Record<
      string,
      { parameter: string; option: string; exitCode: number }
    > = {
      SCHEMA_SYNC_REBUILD_NOT_ALLOWED: {
        parameter: 'allowRebuild',
        option: '--allow-rebuild',
        exitCode: EXIT_REBUILD_NOT_ALLOWED,
      },
      SCHEMA_SYNC_DESTRUCTIVE_NOT_ALLOWED: {
        parameter: 'allowDestructive',
        option: '--allow-destructive',
        exitCode: EXIT_DESTRUCTIVE_NOT_ALLOWED,
      },
    };
    const flag = flags[result.blockedBy.name];
    const message = flag
      ? `${result.blockedBy.message.replace(
          ` (pass ${flag.parameter}=true to allow this)`,
          ''
        )}. Run again with ${flag.option} to allow this`
      : result.blockedBy.message;

    throw new CliError(
      result.dryRun ? `A real sync would be refused: ${message}` : message,
      flag ? flag.exitCode : EXIT_ERROR
    );
  }

  if (!options.json) {
    const { create, update, adopt } = result.summary;
    const deletes = result.summary.delete || 0;

    if (create + update + adopt + deletes === 0) {
      context.log(green('Already up to date'));
    } else {
      context.log(
        result.applied ? green('Applied') : dim('Not applied (dry run)')
      );
    }
  }

  if (result.applied && options.wait) {
    const building = result.changes
      .filter(change => change.build && change.build.buildStatus === 'building')
      .map(change => ({
        listId: change.listId!,
        indexId: change.indexId!,
        label: `${change.list}/${change.index}`,
      }));

    await waitForIndexes(
      context,
      jsonpad,
      building,
      parseTimeout(options.timeout)
    );
  }
}
