import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { Context } from '../../context.ts';
import { CliError, describeApiError } from '../../errors.ts';

type ExportSchemaOptions = {
  scope?: string;
  tagged?: string[];
  lists?: string;
  out?: string;
};

const collect = (value: string, previous: string[] = []) => [
  ...previous,
  value,
];

export function defineExportSchema(
  command: Command,
  context: Context
): Command {
  return command
    .description('Write a schema document for existing lists')
    .option('--scope <scope>', 'Only lists managed by this scope')
    .option(
      '--tagged <tags>',
      'Only lists with one of these comma-separated tags (repeat the option to require every group)',
      collect
    )
    .option('--lists <path names>', 'Only these comma-separated lists')
    .option('--out <file>', 'Write the document to a file, not stdout')
    .action((options: ExportSchemaOptions) => exportSchema(context, options));
}

export async function exportSchema(
  context: Context,
  options: ExportSchemaOptions
): Promise<void> {
  const jsonpad = context.createClient();
  let result;

  try {
    result = await jsonpad.exportSchema({
      scope: options.scope,
      tagged: options.tagged,
      lists: options.lists
        ? options.lists
            .split(',')
            .map(pathName => pathName.trim())
            .filter(Boolean)
        : undefined,
    });
  } catch (error) {
    throw new CliError(describeApiError(error));
  }

  for (const warning of result.warnings) {
    context.error(`${context.colours.yellow('warning')}: ${warning}`);
  }

  const json = `${JSON.stringify(result.document, null, 2)}\n`;

  if (options.out) {
    fs.writeFileSync(path.resolve(context.cwd, options.out), json);
    context.error(
      `Wrote ${Object.keys(result.document.lists).length} lists to ${
        options.out
      }`
    );
  } else {
    context.stdout.write(json);
  }
}
