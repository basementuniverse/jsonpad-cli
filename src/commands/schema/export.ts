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
  splitRules?: string;
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
    .option(
      '--split-rules <directory>',
      "Write each list's write rules and rule tests to their own files in this directory, and reference them from the document (needs --out)"
    )
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

  if (options.splitRules) {
    splitRules(context, result.document, options);
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

/**
 * Move each list's rules and rule tests out of the document and into their
 * own files, which the document then points at with rulesFile and
 * rulesTestsFile
 */
function splitRules(
  context: Context,
  document: { lists: Record<string, Record<string, any>> },
  options: ExportSchemaOptions
): void {
  if (!options.out) {
    throw new CliError('--split-rules needs --out');
  }

  const directory = path.resolve(context.cwd, options.splitRules!);
  const documentDirectory = path.dirname(
    path.resolve(context.cwd, options.out)
  );
  let written = 0;

  fs.mkdirSync(directory, { recursive: true });

  for (const [pathName, list] of Object.entries(document.lists)) {
    const reference = (file: string) => {
      const relative = path.relative(documentDirectory, file);
      // Paths in the document are relative to the document, and always use
      // forward slashes
      return relative.split(path.sep).join('/');
    };

    if (typeof list.rules === 'string' || Array.isArray(list.rules)) {
      const text = Array.isArray(list.rules)
        ? list.rules.join('\n')
        : list.rules;
      const file = path.join(directory, `${pathName}.rules`);
      fs.writeFileSync(file, `${text.replace(/\n?$/, '\n')}`);
      delete list.rules;
      list.rulesFile = reference(file);
      written++;
    }

    if (list.rulesTests) {
      const file = path.join(directory, `${pathName}.tests.json`);
      fs.writeFileSync(file, `${JSON.stringify(list.rulesTests, null, 2)}\n`);
      delete list.rulesTests;
      list.rulesTestsFile = reference(file);
      written++;
    }
  }

  context.error(
    `Wrote ${written} rule ${written === 1 ? 'file' : 'files'} to ${options.splitRules}`
  );
}
