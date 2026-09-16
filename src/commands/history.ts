/**
 * The stats, events and event commands, which lists, items, indexes and
 * identities all have
 */
import { InvalidArgumentError, Option, type Command } from 'commander';
import type { Context } from '../context.ts';
import {
  addOutputOptions,
  formatNumber,
  formatTimestamp,
  printRecord,
  renderDetails,
  renderTable,
  resolveOutputFormat,
  type OutputOptions,
  type RecordOutput,
  type RecordsOutput,
} from '../output.ts';
import {
  addAllOption,
  addPagingOptions,
  parseDate,
  printPages,
  removeUndefined,
  request,
  type AllOptions,
  type PagingOptions,
} from '../resources.ts';
import type { Event, JSONPad, PaginatedResponse } from '../sdk.ts';

/**
 * The API's default for how many days of stats to return
 */
const DEFAULT_STATS_DAYS = 7;
const MAX_STATS_DAYS = 90;

export type HistoryTarget = {
  /**
   * The command's arguments, e.g. [['<list>', 'The list (id or path name)']]
   */
  arguments: [name: string, description: string][];

  /**
   * Turn the arguments into what the API wants, e.g. an identity's group/name
   * into its id
   */
  resolve?: (jsonpad: JSONPad, args: string[]) => Promise<string[]>;
};

type Series = {
  total: number;
  totalThisPeriod: number;
  metrics: {
    date: Date | string;
    count: number;
    types?: Record<string, number>;
  }[];
};

function parseDays(value: string): number {
  const days = Number(value);

  if (!Number.isInteger(days) || days < 1 || days > MAX_STATS_DAYS) {
    throw new InvalidArgumentError(
      `Must be a whole number from 1 to ${MAX_STATS_DAYS}.`
    );
  }

  return days;
}

/**
 * Split a commander action's parameters into positional arguments and options
 */
function actionParameters<T>(parameters: unknown[]): [string[], T] {
  return [
    parameters.slice(0, -2) as string[],
    parameters[parameters.length - 2] as T,
  ];
}

function addArguments(command: Command, target: HistoryTarget): Command {
  for (const [name, description] of target.arguments) {
    command.argument(name, description);
  }

  return command;
}

async function resolveArguments(
  target: HistoryTarget,
  jsonpad: JSONPad,
  args: string[]
): Promise<string[]> {
  return target.resolve ? target.resolve(jsonpad, args) : args;
}

const article = (noun: string) => (/^[aeiou]/.test(noun) ? 'an' : 'a');

/**
 * The day a stats bucket is for, as YYYY-MM-DD
 *
 * The API starts each day at midnight in its own time zone. A bucket that
 * starts at midnight UTC is from a server on UTC, so its UTC date is the day;
 * otherwise the server is (most likely) in the same time zone as this machine
 * (e.g. a local server), so the local date is
 */
export function dateOf(date: Date | string): string {
  const parsed = new Date(date);
  const utc =
    parsed.getUTCHours() === 0 &&
    parsed.getUTCMinutes() === 0 &&
    parsed.getUTCSeconds() === 0;
  const [year, month, day] = utc
    ? [parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()]
    : [parsed.getFullYear(), parsed.getMonth(), parsed.getDate()];

  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Render stats as a summary of each series, and a table of counts by day
 */
export function renderStats(
  context: Context,
  stats: Record<string, unknown>,
  days: number
): string {
  const { dim } = context.colours;
  const series = Object.entries(stats).filter(
    (entry): entry is [string, Series] =>
      !!entry[1] &&
      typeof entry[1] === 'object' &&
      Array.isArray((entry[1] as Series).metrics)
  );
  const limit = (name: string) => {
    const max = stats[`max${name[0].toUpperCase()}${name.slice(1)}`];

    return typeof max === 'number' ? `, limit ${formatNumber(max)}` : '';
  };

  const summary = renderDetails(
    series.map(([name, { total, totalThisPeriod }]) => [
      `${name[0].toUpperCase()}${name.slice(1)}`,
      `${formatNumber(total)} ${dim(
        `(${formatNumber(totalThisPeriod)} in the last ${
          days === 1 ? 'day' : `${days} days`
        }${limit(name)})`
      )}`,
    ])
  );

  const dates = [
    ...new Set(
      series.flatMap(([, { metrics }]) =>
        metrics.map(metric => dateOf(metric.date))
      )
    ),
  ].sort();

  if (dates.length === 0) {
    return summary;
  }

  const countOn = (metrics: Series['metrics'], date: string) =>
    metrics.find(metric => dateOf(metric.date) === date);
  const events = series.find(([name]) => name === 'events')?.[1];

  const table = renderTable(
    context,
    [
      { header: 'DATE', value: (date: string) => date },
      ...series.map(([name, { metrics }]) => ({
        header: name.toUpperCase(),
        value: (date: string) =>
          formatNumber(countOn(metrics, date)?.count ?? 0),
      })),
      ...(events
        ? [
            {
              header: 'EVENT TYPES',
              value: (date: string) =>
                Object.entries(countOn(events.metrics, date)?.types ?? {})
                  .filter(([, count]) => count > 0)
                  .map(([type, count]) => `${type} ${formatNumber(count)}`)
                  .join(', ') || '-',
            },
          ]
        : []),
    ],
    dates
  );

  return `${summary}\n\n${table}`;
}

export function defineStatsCommand(
  parent: Command,
  context: Context,
  target: HistoryTarget & {
    description: string;
    fetch: (
      jsonpad: JSONPad,
      args: string[],
      parameters: { days?: number }
    ) => Promise<object>;
  }
): Command {
  const command = addArguments(
    parent.command('stats').description(target.description),
    target
  )
    .option(
      '--days <number>',
      `How many days of stats, up to ${MAX_STATS_DAYS} (default ${DEFAULT_STATS_DAYS})`,
      parseDays
    )
    .addOption(
      new Option(
        '-o, --output <format>',
        'Output format (default: table in a terminal, otherwise json)'
      ).choices(['table', 'json'])
    )
    .option('--json', 'Output JSON (the same as --output json)');

  return command.action(async (...parameters: unknown[]) => {
    const [args, options] = actionParameters<OutputOptions & { days?: number }>(
      parameters
    );
    const format = resolveOutputFormat(context, options);
    const jsonpad = context.createClient();
    const resolved = await resolveArguments(target, jsonpad, args);
    const stats = await request(context, () =>
      target.fetch(jsonpad, resolved, removeUndefined({ days: options.days }))
    );

    if (format === 'table') {
      context.log(
        renderStats(
          context,
          stats as Record<string, unknown>,
          options.days ?? DEFAULT_STATS_DAYS
        )
      );
    } else {
      context.log(JSON.stringify(stats, null, 2));
    }
  });
}

function eventOutput(
  context: Context
): RecordOutput<Event> & RecordsOutput<Event> {
  const { dim } = context.colours;

  return {
    id: event => event.id,
    details: event => [
      ['ID', event.id],
      ['Type', event.type],
      ['Stream', event.stream],
      ['Model', event.modelId],
      ['Version', event.version ?? dim('(none)')],
      ['Created', formatTimestamp(event.createdAt)],
      ...(event.snapshot !== undefined
        ? [
            ['Snapshot', JSON.stringify(event.snapshot, null, 2)] as [
              string,
              string,
            ],
          ]
        : []),
      ...(event.attachments !== undefined
        ? [
            ['Attachments', JSON.stringify(event.attachments, null, 2)] as [
              string,
              string,
            ],
          ]
        : []),
    ],
    columns: [
      { header: 'ID', value: event => event.id },
      { header: 'TYPE', value: event => event.type },
      { header: 'VERSION', value: event => event.version ?? '-' },
      { header: 'CREATED', value: event => formatTimestamp(event.createdAt) },
    ],
    empty: 'No events',
  };
}

type EventsOptions = PagingOptions &
  AllOptions &
  OutputOptions & {
    type?: string;
    startAt?: string;
    endAt?: string;
    includeSnapshot?: boolean;
    includeAttachments?: boolean;
    restorable?: boolean;
    includeGuarded?: boolean;
  };

export function defineEventCommands(
  parent: Command,
  context: Context,
  target: HistoryTarget & {
    noun: string;
    types: string[];

    /**
     * Item events can be filtered to restorable ones, and have guarded values
     */
    items?: boolean;
    fetchEvents: (
      jsonpad: JSONPad,
      args: string[],
      parameters: Record<string, unknown>
    ) => Promise<PaginatedResponse<Event>>;
    fetchEvent: (
      jsonpad: JSONPad,
      args: string[],
      eventId: string,
      parameters: Record<string, unknown>
    ) => Promise<Event>;
  }
): void {
  const contents = (command: Command) => {
    command
      .option(
        '--include-snapshot',
        `Include the ${target.noun} as it was after each event`
      )
      .option('--include-attachments', "Include each event's attachments");

    if (target.items) {
      command.option(
        '--include-guarded',
        'Include guarded values in snapshots, for items the identity making the request owns'
      );
    }

    return command;
  };

  const events = addArguments(
    parent
      .command('events')
      .description(
        `List ${article(target.noun)} ${target.noun}'s events, newest first by default`
      ),
    target
  )
    .addOption(
      new Option('--type <type>', 'Only events of this type').choices(
        target.types
      )
    )
    .option(
      '--start-at <date>',
      'Only events at or after this date, e.g. 2026-09-01',
      parseDate
    )
    .option('--end-at <date>', 'Only events at or before this date', parseDate);

  if (target.items) {
    events.option(
      '--restorable',
      'Only events the item can be restored to (jsonpad items restore)'
    );
  }

  contents(events);
  addAllOption(events);
  addPagingOptions(events, { choices: ['createdAt', 'type'] });
  addOutputOptions(events).action(async (...parameters: unknown[]) => {
    const [args, options] = actionParameters<EventsOptions>(parameters);
    const jsonpad = context.createClient();
    const resolved = await resolveArguments(target, jsonpad, args);

    await printPages(
      context,
      options,
      paging =>
        target.fetchEvents(
          jsonpad,
          resolved,
          removeUndefined({
            ...paging,
            type: options.type,
            startAt: options.startAt,
            endAt: options.endAt,
            restorable: options.restorable,
            includeSnapshot: options.includeSnapshot,
            includeAttachments: options.includeAttachments,
            includeGuarded: options.includeGuarded,
          })
        ),
      eventOutput(context)
    );
  });

  const event = addArguments(
    parent
      .command('event')
      .description(
        `Show one of ${article(target.noun)} ${target.noun}'s events`
      ),
    target
  ).argument('<event>', 'The event id');

  contents(event);
  addOutputOptions(event).action(async (...parameters: unknown[]) => {
    const [args, options] = actionParameters<EventsOptions>(parameters);
    const eventId = args[args.length - 1];
    const format = resolveOutputFormat(context, options);
    const jsonpad = context.createClient();
    const resolved = await resolveArguments(target, jsonpad, args.slice(0, -1));
    const found = await request(context, () =>
      target.fetchEvent(
        jsonpad,
        resolved,
        eventId,
        removeUndefined({
          includeSnapshot: options.includeSnapshot,
          includeAttachments: options.includeAttachments,
          includeGuarded: options.includeGuarded,
        })
      )
    );

    printRecord(context, format, found, eventOutput(context));
  });
}
