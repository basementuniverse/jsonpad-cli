import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import { describeLimits } from './client.ts';
import { defineConfig } from './commands/config.ts';
import { defineIdentities } from './commands/identities.ts';
import { defineIndexes } from './commands/indexes.ts';
import { defineItems } from './commands/items.ts';
import { defineLists } from './commands/lists.ts';
import { defineRebuildIndex } from './commands/rebuild-index.ts';
import { defineExportSchema } from './commands/schema/export.ts';
import { defineMoveLists } from './commands/schema/move.ts';
import { defineSyncSchema } from './commands/schema/sync.ts';
import { defineWhoami } from './commands/whoami.ts';
import type { Context, GlobalOptions } from './context.ts';
import { CliError, EXIT_ERROR, EXIT_OK } from './errors.ts';

export const { version } = createRequire(import.meta.url)(
  '../package.json'
) as { version: string };

export const ENVIRONMENT_HELP = `Environment:
  JSONPAD_TOKEN      The API token to use, if you don't use a profile. The
                     token needs the sync-schema permission for schema
                     commands, plus permission for each change a sync makes
  JSONPAD_API_URL    The API's URL (default https://api.jsonpad.io)
  JSONPAD_PROFILE    The profile to use, like --profile
  JSONPAD_CONFIG     The config file, where profiles are saved (see
                     jsonpad config path)
  NO_COLOR           Set to turn off coloured output

A profile chosen with --profile or JSONPAD_PROFILE comes first, then
JSONPAD_TOKEN, then the default profile.`;

export const EXIT_CODES_HELP = `Exit codes:
  0  Success
  1  Error, including a sync refused because a change has errors
  2  A sync was refused because it needs --allow-rebuild
  3  An index build failed, or didn't finish in time, while waiting
  4  A sync was refused because it needs --allow-destructive
  5  Refused because it needs confirmation: run again with --yes
  6  Not found
  7  The token isn't allowed to do this, or isn't valid
  8  Rate limited (after retrying), or a plan limit or the monthly quota was
     reached

The schema commands and rebuild-index (and indexes rebuild) exit with 1 for
every API error, as they did in @basementuniverse/jsonpad-sdk.`;

/**
 * Commands that are other names for the commands ported from the SDK, and the
 * commands they're the same as
 */
export const ALIASES: Record<string, string> = {
  'schema sync': 'sync-schema',
  'schema export': 'export-schema',
  'schema move': 'move-lists',
  'indexes rebuild': 'rebuild-index',
};

/**
 * Build the jsonpad command, with its output going to the context's streams
 */
export function createProgram(context: Context): Command {
  const program = new Command('jsonpad')
    .description('The JSONPad command line tool')
    .usage('<command> [options]')
    .version(version, '-v, --version', 'Show the version')
    .helpOption('-h, --help', 'Show help')
    .helpCommand('help [command]', 'Show help for a command')
    .option('--profile <name>', 'Use a saved profile (see jsonpad config)')
    .option('--api-url <url>', "The API's URL, e.g. a local server")
    .option('-V, --verbose', 'Log requests, and the rate limit and quota')
    .showSuggestionAfterError()
    .configureHelp({ showGlobalOptions: true })
    .exitOverride()
    .configureOutput({
      writeOut: text => void context.stdout.write(text),
      writeErr: text => void context.stderr.write(text),
      outputError: (text, write) => write(context.colours.red(text)),
    })
    .addHelpText('after', `\n${ENVIRONMENT_HELP}\n\n${EXIT_CODES_HELP}\n`)
    .hook('preAction', (_program, command) => {
      context.globalOptions = command.optsWithGlobals<GlobalOptions>();
    });

  // Subcommands inherit the settings above (output, exit override, help
  // option), as long as they're added after them
  defineSyncSchema(program.command('sync-schema'), context);
  defineExportSchema(program.command('export-schema'), context);
  defineMoveLists(program.command('move-lists'), context);
  defineRebuildIndex(program.command('rebuild-index'), context);

  const schema = program
    .command('schema')
    .description(
      'Schema sync commands (the same as sync-schema, export-schema and move-lists)'
    );
  defineSyncSchema(schema.command('sync'), context);
  defineExportSchema(schema.command('export'), context);
  defineMoveLists(schema.command('move'), context);

  defineLists(program.command('lists'), context);
  defineIndexes(program.command('indexes'), context);
  defineItems(program.command('items'), context);
  defineIdentities(program.command('identities'), context);

  defineWhoami(program.command('whoami'), context);
  defineConfig(program.command('config'), context);

  return program;
}

/**
 * Run the jsonpad command with some arguments, and return the exit code
 */
export async function run(
  argv: string[],
  context: Context,
  program: Command = createProgram(context)
): Promise<number> {
  if (argv.length === 0) {
    program.outputHelp();
    return EXIT_OK;
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
    return EXIT_OK;
  } catch (error) {
    return handleError(context, error);
  } finally {
    if (context.globalOptions.verbose && context.client) {
      const limits = describeLimits(context.client.lastResponse);

      if (limits) {
        context.error(context.colours.dim(limits));
      }
    }
  }
}

function handleError(context: Context, error: unknown): number {
  // Commander has already written its own messages, including help and the
  // version, which also end up here
  if (error instanceof CommanderError) {
    return error.exitCode;
  }

  const { red } = context.colours;
  if (error instanceof CliError) {
    context.error(red(error.message));
    return error.exitCode;
  }

  context.error(
    red(`Error: ${error instanceof Error ? error.stack : String(error)}`)
  );
  return EXIT_ERROR;
}
