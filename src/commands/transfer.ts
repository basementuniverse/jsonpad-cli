/**
 * items export and items import: copying a list's items to and from NDJSON
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { installRequestPacing, requestInterval } from '../client.ts';
import type { Context } from '../context.ts';
import { apiError, CliError, EXIT_ERROR } from '../errors.ts';
import { readStdin } from '../input.ts';
import { formatNumber, plural } from '../output.ts';
import {
  fetchAll,
  parsePositiveInteger,
  removeUndefined,
  request,
} from '../resources.ts';
import type { Item, JSONPad } from '../sdk.ts';

/**
 * The fields of an exported item that importing sets. Everything else (its id,
 * dates, version, size) belongs to the new item
 */
const IMPORTED_FIELDS = ['data', 'description', 'tags', 'readonly'] as const;

type ExportOptions = {
  out?: string;
  dataOnly?: boolean;
  where?: string[];
  tagged?: string[];
  includeGuarded?: boolean;
  max?: number;
};

type ImportOptions = {
  dataOnly?: boolean;
  dryRun?: boolean;
  continueOnError?: boolean;
};

/**
 * Show progress on stderr, overwriting the same line, in a terminal only
 */
function progress(context: Context, text: string | null): void {
  if (!context.stderr.isTTY) {
    return;
  }

  context.stderr.write(text === null ? '\r\x1b[K' : `\r\x1b[K${text}`);
}

export function defineTransferCommands(
  command: Command,
  context: Context,
  whereParameters: (where?: string[]) => Record<string, string>
): void {
  command
    .command('export')
    .summary('Output every item in a list as NDJSON, e.g. for a backup')
    .description(
      'Output every item in a list as NDJSON (one item per line), oldest first, e.g. for a backup. Import them again with jsonpad items import'
    )
    .argument('<list>', 'The list (id or path name)')
    .option('--out <file>', 'Write to a file, not stdout')
    .option('--data-only', "Only output each item's data")
    .option(
      '--where <index=value>',
      'Only items whose indexed value matches (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option(
      '--tagged <tags>',
      'Only items with one of these comma-separated tags (repeat the option to require every group)',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option(
      '--include-guarded',
      'Include guarded values, for items the identity making the request owns'
    )
    .option(
      '--max <number>',
      'Stop after this many items',
      parsePositiveInteger
    )
    .action((listId: string, options: ExportOptions) =>
      exportItems(context, listId, options, whereParameters(options.where))
    );

  command
    .command('import')
    .summary('Create items from an NDJSON or JSON file')
    .description(
      'Create an item for each record in a file: NDJSON (one record per line), or a JSON array. Records are items, as jsonpad items export outputs them, or with --data-only, item data. Items are created one at a time, at the pace the plan allows'
    )
    .argument('<list>', 'The list (id or path name)')
    .argument('<file>', 'The file to import, or - for stdin')
    .option('--data-only', 'Each record is the data for an item')
    .option(
      '--dry-run',
      'Check the records, and say how many items would be created, without creating any'
    )
    .option(
      '--continue-on-error',
      "Carry on when an item can't be created, instead of stopping"
    )
    .action((listId: string, file: string, options: ImportOptions) =>
      importItems(context, listId, file, options)
    );
}

async function exportItems(
  context: Context,
  listId: string,
  options: ExportOptions,
  where: Record<string, string>
): Promise<void> {
  const jsonpad = context.createClient();
  const parameters = removeUndefined({
    ...where,
    order: 'createdAt',
    direction: 'asc' as const,
    tagged: options.tagged,
    includeGuarded: options.includeGuarded,
  });

  // Oldest first, so that items created during the export are added to the
  // last page rather than moving others onto pages that have been fetched
  const records: AsyncIterable<unknown> = options.dataOnly
    ? fetchAll(
        context,
        paging => jsonpad.fetchItemsData(listId, { ...parameters, ...paging }),
        options.max
      )
    : fetchAll(
        context,
        paging =>
          jsonpad.fetchItems(listId, {
            ...parameters,
            ...paging,
            includeData: true,
          }),
        options.max
      );

  // A file is written under a temporary name and moved into place at the end,
  // so a failed export never leaves a partial file that looks complete
  const file = options.out ? path.resolve(context.cwd, options.out) : null;
  const partialFile = file ? `${file}.partial` : null;
  const stream = partialFile ? fs.createWriteStream(partialFile) : null;
  const write = (text: string) =>
    stream
      ? new Promise<void>((resolve, reject) =>
          stream.write(text, error => (error ? reject(error) : resolve()))
        )
      : void context.stdout.write(text);

  let count = 0;
  try {
    for await (const record of records) {
      await write(`${JSON.stringify(record)}\n`);
      count++;

      if (stream && count % 100 === 0) {
        progress(context, `Exported ${formatNumber(count)} items...`);
      }
    }
  } catch (error) {
    if (stream) {
      progress(context, null);
      await new Promise(resolve => stream.end(resolve));
      fs.rmSync(partialFile!, { force: true });
    }
    throw error;
  }

  if (stream) {
    await new Promise(resolve => stream.end(resolve));
    fs.renameSync(partialFile!, file!);
    progress(context, null);
    context.error(
      `Exported ${plural(count, 'item')} from ${listId} to ${options.out}`
    );
  }
}

type ImportRecord = {
  /**
   * Where the record is in the input, e.g. "line 12" or "record 3"
   */
  position: string;

  /**
   * The line number, for NDJSON
   */
  line?: number;
  body: Record<string, unknown>;
};

/**
 * Parse an import's records, and turn each one into the body for creating an
 * item. Every problem is found before anything is created
 */
export function parseImport(
  text: string,
  dataOnly: boolean
): { records: ImportRecord[]; errors: string[] } {
  const records: ImportRecord[] = [];
  const errors: string[] = [];
  let values: { position: string; line?: number; value: unknown }[];

  // A file that's one JSON array is a list of records. Anything else is NDJSON
  let whole: unknown;
  let isArray = false;
  try {
    whole = JSON.parse(text);
    isArray = Array.isArray(whole);
  } catch {}

  if (isArray) {
    values = (whole as unknown[]).map((value, i) => ({
      position: `record ${i + 1}`,
      value,
    }));
  } else {
    values = [];
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) {
        return;
      }

      try {
        values.push({
          position: `line ${i + 1}`,
          line: i + 1,
          value: JSON.parse(line),
        });
      } catch (error: any) {
        errors.push(`line ${i + 1}: isn't valid JSON (${error.message})`);
      }
    });
  }

  for (const { position, line, value } of values) {
    if (dataOnly) {
      records.push({ position, line, body: { data: value } });
      continue;
    }

    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('data' in value)
    ) {
      errors.push(
        `${position}: isn't an item (an object with data). Use --data-only if each record is an item's data`
      );
      continue;
    }

    const item = value as Record<string, unknown>;
    records.push({
      position,
      line,
      body: Object.fromEntries(
        IMPORTED_FIELDS.filter(field => item[field] !== undefined).map(
          field => [field, item[field]]
        )
      ),
    });
  }

  return { records, errors };
}

async function readImportFile(context: Context, file: string): Promise<string> {
  if (file === '-') {
    return readStdin(context);
  }

  try {
    return fs.readFileSync(path.resolve(context.cwd, file), 'utf8');
  } catch (error: any) {
    throw new CliError(
      error.code === 'ENOENT'
        ? `Can't find ${file}`
        : `Can't read ${file}: ${error.message}`
    );
  }
}

/**
 * Pace requests to the plan's limits, and warn if the import is likely to use
 * up the monthly quota or take a long time
 */
async function prepareForImport(
  context: Context,
  jsonpad: JSONPad,
  count: number
): Promise<void> {
  const { yellow } = context.colours;
  const { plan, usage } = await request(context, () =>
    jsonpad.fetchSelfToken()
  );
  const interval = requestInterval(plan);

  installRequestPacing(context, interval);

  if (usage.requestsRemaining !== null && count > usage.requestsRemaining) {
    context.error(
      `${yellow('warning')}: this imports ${formatNumber(count)} items, but the account has ${formatNumber(
        usage.requestsRemaining
      )} requests left this month. Creating items will be refused once they run out`
    );
  }

  const minutes = Math.round((count * interval) / 60_000);
  if (minutes >= 2) {
    context.error(
      `This will take about ${plural(minutes, 'minute')}, at the pace the ${plan.name} plan allows`
    );
  }
}

async function importItems(
  context: Context,
  listId: string,
  file: string,
  options: ImportOptions
): Promise<void> {
  const text = await readImportFile(context, file);
  const { records, errors } = parseImport(text, !!options.dataOnly);

  if (errors.length > 0) {
    const shown = errors.slice(0, 10);

    throw new CliError(
      [
        `Nothing was imported, because ${plural(errors.length, 'record')} ${
          errors.length === 1 ? "isn't" : "aren't"
        } valid:`,
        ...shown.map(error => `  ${error}`),
        ...(errors.length > shown.length
          ? [`  and ${formatNumber(errors.length - shown.length)} more`]
          : []),
      ].join('\n')
    );
  }

  if (options.dryRun) {
    context.error(
      `${plural(records.length, 'item')} would be created in ${listId}. Nothing was imported (dry run)`
    );
    return;
  }

  if (records.length === 0) {
    context.error('There are no records to import');
    return;
  }

  const jsonpad = context.createClient();
  await prepareForImport(context, jsonpad, records.length);

  let created = 0;
  const failures: string[] = [];

  for (const record of records) {
    progress(
      context,
      `Importing ${formatNumber(created + failures.length + 1)} of ${formatNumber(
        records.length
      )}...`
    );

    try {
      await jsonpad.createItem(listId, record.body as Partial<Item>, {
        includeData: false,
      });
      created++;
    } catch (error) {
      const failure = apiError(error, context.auth?.apiUrl);
      progress(context, null);

      if (!options.continueOnError) {
        const resume =
          record.line !== undefined && file !== '-'
            ? ` To import the rest, fix it and run: tail -n +${record.line} ${file} | jsonpad items import ${listId} -`
            : '';

        throw new CliError(
          `Stopped at ${record.position}: ${failure.message}\n${
            created === 0
              ? 'No items were created.'
              : `${plural(created, 'item was', 'items were')} created before it.`
          }${resume}`,
          failure.exitCode
        );
      }

      failures.push(record.position);
      context.error(`${record.position}: ${failure.message}`);
    }
  }

  progress(context, null);
  context.error(
    `Created ${plural(created, 'item')} in ${listId}${
      failures.length > 0
        ? `. ${plural(failures.length, 'record')} failed: ${failures.join(', ')}`
        : ''
    }`
  );

  if (failures.length > 0) {
    throw new CliError(
      `${plural(failures.length, 'item')} couldn't be created`,
      EXIT_ERROR
    );
  }
}
