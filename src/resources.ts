import { InvalidArgumentError, Option, type Command } from 'commander';
import type { Context } from './context.ts';
import { apiError, CliError, EXIT_NOT_FOUND } from './errors.ts';
import { collectList, readJsonInput } from './input.ts';
import {
  formatNumber,
  printPage,
  printRecords,
  resolveOutputFormat,
  type OutputOptions,
  type RecordsOutput,
} from './output.ts';
import type { Identity, JSONPad, PaginatedResponse } from './sdk.ts';

export const MAX_PAGE_SIZE = 100;

export type PagingOptions = {
  page?: number;
  limit?: number;
  order?: string;
  direction?: 'asc' | 'desc';
};

function parsePositiveInteger(value: string): number {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new InvalidArgumentError('Must be a whole number, 1 or more.');
  }

  return number;
}

function parseLimit(value: string): number {
  const number = parsePositiveInteger(value);

  if (number > MAX_PAGE_SIZE) {
    throw new InvalidArgumentError(`Must be ${MAX_PAGE_SIZE} or less.`);
  }

  return number;
}

/**
 * Add --page, --limit, --order and --direction to a command that fetches a
 * page of records
 */
export function addPagingOptions(
  command: Command,
  order: { choices?: string[]; description?: string } = {}
): Command {
  const orderOption = new Option(
    '--order <field>',
    order.description ?? 'The field to order by'
  );
  if (order.choices) {
    orderOption.choices(order.choices);
  }

  return command
    .option(
      '--page <number>',
      'The page to fetch (default 1)',
      parsePositiveInteger
    )
    .option(
      '--limit <number>',
      `How many to fetch per page, up to ${MAX_PAGE_SIZE} (default 20)`,
      parseLimit
    )
    .addOption(orderOption)
    .addOption(
      new Option('--direction <direction>', 'The order direction').choices([
        'asc',
        'desc',
      ])
    );
}

export function pagingParameters(options: PagingOptions) {
  return removeUndefined({
    page: options.page,
    limit: options.limit,
    order: options.order,
    direction: options.direction,
  });
}

/**
 * Add --name and --no-name for a boolean, so that leaving both out means
 * "don't change it" or "don't filter by it"
 */
export function addBooleanOption(
  command: Command,
  flag: string,
  description: string,
  negatedDescription: string
): Command {
  return command
    .option(`--${flag}`, description)
    .option(`--no-${flag}`, negatedDescription);
}

/**
 * Add --tags, which replaces a resource's tags
 */
export function addTagsOption(command: Command): Command {
  return command.option(
    '--tags <tags>',
    'Comma-separated tags, replacing any it has (repeatable; pass "" to remove them all)',
    collectList
  );
}

/**
 * Add --tagged, which filters by tags
 */
export function addTaggedOption(command: Command): Command {
  return command.option(
    '--tagged <tags>',
    'Only those with one of these comma-separated tags (repeat the option to require every group)',
    (value: string, previous: string[] = []) => [...previous, value]
  );
}

export function removeUndefined<T extends Record<string, unknown>>(
  object: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

/**
 * A nullable field set with --field <value> and cleared with --no-field, which
 * commander gives as false
 */
export function nullable<T>(
  value: T | false | undefined
): T | null | undefined {
  return value === false ? null : value;
}

/**
 * Build a request body from --data (a JSON object) and field options, which
 * take precedence over the same fields in --data
 */
export async function readBody(
  context: Context,
  data: string | undefined,
  fields: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};

  if (data !== undefined) {
    const parsed = await readJsonInput(context, '--data', data);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError('--data must be a JSON object');
    }
    body = parsed as Record<string, unknown>;
  }

  return { ...body, ...removeUndefined(fields) };
}

/**
 * Make a request, turning an API error into a CliError with the right exit
 * code
 */
export async function request<T>(
  context: Context,
  send: () => Promise<T>
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    throw apiError(error, context.auth?.apiUrl);
  }
}

/**
 * A JSON pointer as the SDK wants it: without its leading slash, since the SDK
 * adds one
 */
export function sdkPointer(pointer: string | undefined): string | undefined {
  return pointer === undefined ? undefined : pointer.replace(/^\/+/, '');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Find an identity's id from what was passed on the command line: its id,
 * group/name, or the name of an identity with no group
 *
 * The API only looks identities up by id, and its name and group filters
 * match partially, so the matches are narrowed down to exact ones here
 */
export async function resolveIdentityId(
  context: Context,
  jsonpad: JSONPad,
  reference: string
): Promise<string> {
  if (UUID.test(reference)) {
    return reference;
  }

  // Names can't contain a slash, but groups can
  const slash = reference.lastIndexOf('/');
  const group = slash === -1 ? null : reference.slice(0, slash);
  const name = reference.slice(slash + 1);

  const page = await request(context, () =>
    jsonpad.fetchIdentities({
      name,
      ...(group ? { group } : {}),
      limit: MAX_PAGE_SIZE,
    })
  );
  const matches = page.data.filter(
    (identity: Identity) =>
      identity.name === name && (identity.group || null) === group
  );

  if (matches.length === 0) {
    throw new CliError(
      group
        ? `There's no identity named "${name}" in the group "${group}"`
        : `There's no identity named "${name}" without a group. Use group/name for an identity in a group, or its id`,
      EXIT_NOT_FOUND
    );
  }

  return matches[0].id;
}

export type AllOptions = {
  all?: boolean;
  max?: number;
};

/**
 * Add --all and --max to a command that fetches a page of records
 */
export function addAllOption(command: Command): Command {
  return command
    .option(
      '--all',
      'Fetch every page, not just one. The output is NDJSON unless --output says otherwise'
    )
    .option(
      '--max <number>',
      'With --all, stop after this many',
      parsePositiveInteger
    );
}

/**
 * Fetch every page of records, a page at a time, with the most records a page
 * can have. Stops after max records, if given
 *
 * Pages are fetched by number, so records added or deleted while this runs
 * can be skipped or repeated. Order by creation date for the most stable
 * results
 */
export async function* fetchAll<T>(
  context: Context,
  fetchPage: (parameters: {
    page: number;
    limit: number;
  }) => Promise<PaginatedResponse<T>>,
  max?: number
): AsyncGenerator<T, void, undefined> {
  let fetched = 0;

  for (let page = 1; ; page++) {
    const response = await request(context, () =>
      fetchPage({ page, limit: MAX_PAGE_SIZE })
    );

    for (const record of response.data) {
      if (max !== undefined && fetched >= max) {
        return;
      }

      fetched++;
      yield record;
    }

    if (
      response.data.length < MAX_PAGE_SIZE ||
      page * MAX_PAGE_SIZE >= response.total ||
      (max !== undefined && fetched >= max)
    ) {
      return;
    }
  }
}

export function checkAllOptions(options: PagingOptions & AllOptions): void {
  if (
    options.all &&
    (options.page !== undefined || options.limit !== undefined)
  ) {
    throw new CliError(
      "--page and --limit fetch one page, so they can't be used with --all. Use --max to limit how many are fetched"
    );
  }
  if (!options.all && options.max !== undefined) {
    throw new CliError('--max only works with --all');
  }
}

/**
 * Fetch and output a page of records, or with --all, every page
 *
 * With --all, NDJSON and ids are output as each page arrives. JSON and tables
 * are output once everything has been fetched
 */
export async function printPages<T>(
  context: Context,
  options: PagingOptions & AllOptions & OutputOptions,
  fetchPage: (
    parameters: Partial<PagingOptions>
  ) => Promise<PaginatedResponse<T>>,
  output: RecordsOutput<T>
): Promise<void> {
  checkAllOptions(options);

  if (!options.all) {
    const format = resolveOutputFormat(context, options);
    const page = await request(context, () =>
      fetchPage(pagingParameters(options))
    );

    printPage(context, format, page, output);
    return;
  }

  const format = resolveOutputFormat(context, options, 'ndjson');
  const records = fetchAll(
    context,
    parameters => fetchPage({ ...pagingParameters(options), ...parameters }),
    options.max
  );

  if (format === 'ndjson' || format === 'id') {
    for await (const record of records) {
      printRecords(context, format, [record], output);
    }
    return;
  }

  const all: T[] = [];
  for await (const record of records) {
    all.push(record);
  }

  printRecords(context, format, all, output);
  if (format === 'table' && all.length > 0) {
    context.error(context.colours.dim(`${formatNumber(all.length)} total`));
  }
}

/**
 * Parse a date option, e.g. --start-at, into an ISO 8601 string
 */
export function parseDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new InvalidArgumentError(
      'Must be a date, e.g. 2026-09-01 or 2026-09-01T12:00:00Z.'
    );
  }

  return date.toISOString();
}

export { parsePositiveInteger };
