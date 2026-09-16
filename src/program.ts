import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import { defineRebuildIndex } from './commands/rebuild-index.ts';
import { defineExportSchema } from './commands/schema/export.ts';
import { defineMoveLists } from './commands/schema/move.ts';
import { defineSyncSchema } from './commands/schema/sync.ts';
import type { Context } from './context.ts';
import { CliError, EXIT_ERROR, EXIT_OK } from './errors.ts';

export const { version } = createRequire(import.meta.url)(
  '../package.json'
) as { version: string };

export const ENVIRONMENT_HELP = `Environment:
  JSONPAD_TOKEN      The API token to use (required). The token needs the
                     sync-schema permission for schema commands, plus
                     permission for each change a sync makes
  JSONPAD_API_URL    The API's URL (default https://api.jsonpad.io)
  NO_COLOR           Set to turn off coloured output`;

export const EXIT_CODES_HELP = `Exit codes:
  0  Success
  1  Error, including a sync refused because a change has errors
  2  A sync was refused because it needs --allow-rebuild
  3  An index build failed, or didn't finish in time, while waiting
  4  A sync was refused because it needs --allow-destructive`;

/**
 * The `jsonpad schema ...` commands, and the top-level commands they're the
 * same as
 */
export const SCHEMA_ALIASES: Record<string, string> = {
  'schema sync': 'sync-schema',
  'schema export': 'export-schema',
  'schema move': 'move-lists',
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
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: text => void context.stdout.write(text),
      writeErr: text => void context.stderr.write(text),
      outputError: (text, write) => write(context.colours.red(text)),
    })
    .addHelpText('after', `\n${ENVIRONMENT_HELP}\n\n${EXIT_CODES_HELP}\n`);

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
}
