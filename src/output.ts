import { Option, type Command } from 'commander';
import type { Context } from './context.ts';
import { CliError } from './errors.ts';

export type Colours = Record<
  'green' | 'yellow' | 'red' | 'cyan' | 'dim' | 'bold',
  (text: string) => string
>;

export function createColours(enabled: boolean): Colours {
  const colour = (code: number) => (text: string) =>
    enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

  return {
    green: colour(32),
    yellow: colour(33),
    red: colour(31),
    cyan: colour(36),
    dim: colour(2),
    bold: colour(1),
  };
}

const ANSI_ESCAPES = /\x1b\[[0-9;]*m/g;

/**
 * The width of some text as it appears in a terminal, without colour codes
 */
function visibleLength(text: string): number {
  return text.replace(ANSI_ESCAPES, '').length;
}

/**
 * Show a value from a change as JSON, shortened to fit on one line
 */
export function formatValue(value: unknown): string {
  const json = JSON.stringify(value);

  return json !== undefined && json.length > 60
    ? `${json.slice(0, 57)}...`
    : String(json);
}

export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * A date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Output formats
// -----------------------------------------------------------------------------

export const OUTPUT_FORMATS = ['table', 'json', 'ndjson', 'id'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type OutputOptions = {
  output?: OutputFormat;
  json?: boolean;
  quiet?: boolean;
};

/**
 * Add --output, --json and --quiet to a command
 */
export function addOutputOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        '-o, --output <format>',
        'Output format (default: table in a terminal, otherwise json)'
      ).choices(OUTPUT_FORMATS)
    )
    .option('--json', 'Output JSON (the same as --output json)')
    .option('-q, --quiet', 'Only output ids (the same as --output id)');
}

/**
 * Work out the output format from --output, --json and --quiet. Without them,
 * it's a table in a terminal, and JSON anywhere else (e.g. piped to jq)
 */
export function resolveOutputFormat(
  context: Context,
  options: OutputOptions
): OutputFormat {
  const chosen = new Set<OutputFormat>([
    ...(options.output ? [options.output] : []),
    ...(options.json ? ['json' as const] : []),
    ...(options.quiet ? ['id' as const] : []),
  ]);

  if (chosen.size > 1) {
    throw new CliError(
      'Choose one output format: --output, --json and --quiet disagree'
    );
  }

  return [...chosen][0] ?? (context.stdout.isTTY ? 'table' : 'json');
}

export type Column<T> = {
  header: string;
  value: (record: T) => string;
};

const MAX_CELL_LENGTH = 60;

function truncate(text: string): string {
  return visibleLength(text) > MAX_CELL_LENGTH
    ? `${text.replace(ANSI_ESCAPES, '').slice(0, MAX_CELL_LENGTH - 1)}…`
    : text;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

/**
 * Render records as a table with a header row
 */
export function renderTable<T>(
  context: Context,
  columns: Column<T>[],
  records: T[]
): string {
  const rows = records.map(record =>
    columns.map(column => truncate(column.value(record)))
  );
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...rows.map(row => visibleLength(row[i])))
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : pad(cell, widths[i])))
      .join('  ')
      .trimEnd();

  return [
    context.colours.dim(line(columns.map(column => column.header))),
    ...rows.map(line),
  ].join('\n');
}

/**
 * Render label and value pairs, one per line, with the values lined up
 */
export function renderDetails(rows: [label: string, value: string][]): string {
  const width = Math.max(...rows.map(([label]) => label.length));

  return rows
    .map(([label, value]) => `${label.padEnd(width)}  ${value}`.trimEnd())
    .join('\n');
}

export type RecordOutput<T> = {
  id: (record: T) => string;

  /**
   * Rows for the table format
   */
  details: (record: T) => [label: string, value: string][];

  /**
   * What the json and ndjson formats output, if not the record itself
   */
  data?: (record: T) => unknown;
};

/**
 * Output one record
 */
export function printRecord<T>(
  context: Context,
  format: OutputFormat,
  record: T,
  output: RecordOutput<T>
): void {
  const data = output.data ? output.data(record) : record;

  switch (format) {
    case 'table':
      context.log(renderDetails(output.details(record)));
      break;
    case 'json':
      context.log(JSON.stringify(data, null, 2));
      break;
    case 'ndjson':
      context.log(JSON.stringify(data));
      break;
    case 'id':
      context.log(output.id(record));
      break;
  }
}

export type RecordsOutput<T> = {
  id: (record: T) => string;
  columns: Column<T>[];
  data?: (record: T) => unknown;

  /**
   * Shown instead of an empty table
   */
  empty: string;
};

/**
 * Output a list of records
 */
export function printRecords<T>(
  context: Context,
  format: OutputFormat,
  records: T[],
  output: RecordsOutput<T>
): void {
  const data = (record: T) => (output.data ? output.data(record) : record);

  switch (format) {
    case 'table':
      if (records.length === 0) {
        context.error(context.colours.dim(output.empty));
      } else {
        context.log(renderTable(context, output.columns, records));
      }
      break;
    case 'json':
      context.log(JSON.stringify(records.map(data), null, 2));
      break;
    case 'ndjson':
      records.forEach(record => context.log(JSON.stringify(data(record))));
      break;
    case 'id':
      records.forEach(record => context.log(output.id(record)));
      break;
  }
}

export type Page<T> = {
  page: number;
  limit: number;
  total: number;
  data: T[];
};

/**
 * Output a page of records. As JSON, the page keeps its page, limit and total;
 * as a table, they're described on stderr
 */
export function printPage<T>(
  context: Context,
  format: OutputFormat,
  page: Page<T>,
  output: RecordsOutput<T>
): void {
  if (format === 'json') {
    context.log(
      JSON.stringify(
        {
          ...page,
          data: page.data.map(record =>
            output.data ? output.data(record) : record
          ),
        },
        null,
        2
      )
    );
    return;
  }

  printRecords(context, format, page.data, output);

  if (format === 'table' && page.total > 0) {
    const pages = Math.max(1, Math.ceil(page.total / page.limit));

    context.error(
      context.colours.dim(
        `page ${page.page} of ${pages} (${formatNumber(page.total)} total)`
      )
    );
  }
}
