import type { Command } from 'commander';
import type { Context } from '../context.ts';
import { CliError } from '../errors.ts';
import { canPrompt, confirm, readJsonInput } from '../input.ts';
import {
  addOutputOptions,
  formatFlags,
  formatNumber,
  formatTimestamp,
  printRecord,
  printRecords,
  resolveOutputFormat,
  type OutputOptions,
  type RecordOutput,
  type RecordsOutput,
} from '../output.ts';
import {
  addBooleanOption,
  addAllOption,
  addPagingOptions,
  addTaggedOption,
  addTagsOption,
  nullable,
  readBody,
  removeUndefined,
  printPages,
  request,
  type AllOptions,
  type PagingOptions,
} from '../resources.ts';
import type { List, SearchResult } from '../sdk.ts';
import { defineEventCommands, defineStatsCommand } from './history.ts';

const FLAGS = [
  'pinned',
  'readonly',
  'realtime',
  'protected',
  'indexable',
  'generative',
] as const;

const FLAG_DESCRIPTIONS: Record<(typeof FLAGS)[number], [string, string]> = {
  pinned: ['Pinned in the dashboard', 'Not pinned'],
  readonly: ["Items can't be created, changed or deleted", 'Not readonly'],
  realtime: ['Changes are sent to realtime clients', 'Not realtime'],
  protected: ["The list can't be deleted while it has items", 'Not protected'],
  indexable: [
    'Items can be listed, filtered and searched with a token',
    'Not indexable',
  ],
  generative: [
    'Items can be generated from the generative prompt',
    'Not generative',
  ],
};

const ORDER_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'pathName',
  ...FLAGS,
  'activated',
];

type ListFields = {
  name?: string;
  pathName?: string;
  description?: string;
  tags?: string[];
  schema?: string | false;
  generativePrompt?: string | false;
  data?: string;
} & Partial<Record<(typeof FLAGS)[number], boolean>>;

export function listDetails(context: Context, list: List): [string, string][] {
  const { dim } = context.colours;
  const rows: [string, string][] = [
    ['ID', list.id],
    ['Path name', list.pathName || dim('(none)')],
    ['Name', list.name],
    ['Description', list.description || dim('(none)')],
    ['Tags', list.tags?.length ? list.tags.join(', ') : dim('(none)')],
    ['Items', formatNumber(list.itemCount ?? 0)],
    ['Flags', formatFlags(list, [...FLAGS])],
  ];

  if (list.generative) {
    rows.push(['Prompt', list.generativePrompt || dim('(none)')]);
  }

  rows.push(
    [
      'Schema',
      list.schema ? JSON.stringify(list.schema, null, 2) : dim('(none)'),
    ],
    ['Created', formatTimestamp(list.createdAt)],
    ['Updated', formatTimestamp(list.updatedAt)]
  );

  return rows;
}

function listOutput(
  context: Context
): RecordOutput<List> & RecordsOutput<List> {
  return {
    id: list => list.id,
    details: list => listDetails(context, list),
    columns: [
      { header: 'ID', value: list => list.id },
      { header: 'PATH NAME', value: list => list.pathName },
      { header: 'NAME', value: list => list.name },
      { header: 'ITEMS', value: list => formatNumber(list.itemCount ?? 0) },
      { header: 'FLAGS', value: list => formatFlags(list, [...FLAGS]) },
      { header: 'UPDATED', value: list => formatTimestamp(list.updatedAt) },
    ],
    empty: 'No lists',
  };
}

/**
 * The options lists create and update share
 */
function addListFieldOptions(command: Command, update: boolean): Command {
  command
    .option('--name <name>', 'The name')
    .option(
      '--path-name <path name>',
      'The path name, which can be used in place of the id'
    )
    .option('--description <text>', 'The description');
  addTagsOption(command);
  command
    .option(
      '--schema <json>',
      'A JSON schema that items must match: JSON, @file or - for stdin'
    )
    .option(
      '--generative-prompt <text>',
      'The prompt used to generate items, for generative lists'
    );

  if (update) {
    command
      .option('--no-schema', 'Remove the schema')
      .option('--no-generative-prompt', 'Remove the generative prompt');
  }

  for (const flag of FLAGS) {
    const [description, negated] = FLAG_DESCRIPTIONS[flag];
    addBooleanOption(command, flag, description, negated);
  }

  return command.option(
    '--data <json>',
    'The whole list as a JSON object (JSON, @file or - for stdin); the options above take precedence'
  );
}

async function listBody(context: Context, options: ListFields) {
  const schema =
    typeof options.schema === 'string'
      ? await readJsonInput(context, '--schema', options.schema)
      : nullable(options.schema);

  return readBody(context, options.data, {
    name: options.name,
    pathName: options.pathName,
    description: options.description,
    tags: options.tags,
    schema,
    generativePrompt: nullable(options.generativePrompt),
    ...Object.fromEntries(FLAGS.map(flag => [flag, options[flag]])),
  });
}

export function defineLists(command: Command, context: Context): Command {
  command.description('Create, view, change and delete lists');

  const list = command
    .command('list', { isDefault: true })
    .alias('ls')
    .description('List lists (the default when no command is given)')
    .option('--name <name>', 'Only lists whose name contains this')
    .option(
      '--path-name <path name>',
      'Only lists whose path name contains this'
    );
  addTaggedOption(list);
  for (const flag of FLAGS) {
    addBooleanOption(
      list,
      flag,
      `Only ${flag} lists`,
      `Only lists that aren't ${flag}`
    );
  }
  addAllOption(list);
  addPagingOptions(list, { choices: ORDER_FIELDS });
  addOutputOptions(list).action(
    async (
      options: PagingOptions &
        AllOptions &
        OutputOptions &
        ListFields & { tagged?: string[] }
    ) => {
      const jsonpad = context.createClient();
      await printPages(
        context,
        options,
        paging =>
          jsonpad.fetchLists(
            removeUndefined({
              ...paging,
              name: options.name,
              pathName: options.pathName,
              tagged: options.tagged,
              ...Object.fromEntries(FLAGS.map(flag => [flag, options[flag]])),
            }) as Parameters<typeof jsonpad.fetchLists>[0]
          ),
        listOutput(context)
      );
    }
  );

  addOutputOptions(
    command
      .command('get')
      .description('Show a list')
      .argument('<list>', 'The list (id or path name)')
  ).action(async (listId: string, options: OutputOptions) => {
    const format = resolveOutputFormat(context, options);
    const jsonpad = context.createClient();
    const list = await request(context, () => jsonpad.fetchList(listId));

    printRecord(context, format, list, listOutput(context));
  });

  addOutputOptions(
    addListFieldOptions(
      command.command('create').description('Create a list'),
      false
    )
  ).action(async (options: ListFields & OutputOptions) => {
    const format = resolveOutputFormat(context, options);
    const body = await listBody(context, options);
    const jsonpad = context.createClient();
    const list = await request(context, () => jsonpad.createList(body));

    printRecord(context, format, list, listOutput(context));
  });

  addOutputOptions(
    addListFieldOptions(
      command
        .command('update')
        .description(
          "Change a list. Fields that aren't given are left as they are"
        )
        .argument('<list>', 'The list (id or path name)'),
      true
    )
  ).action(async (listId: string, options: ListFields & OutputOptions) => {
    const format = resolveOutputFormat(context, options);
    const body = await listBody(context, options);
    const jsonpad = context.createClient();
    const list = await request(context, () => jsonpad.updateList(listId, body));

    printRecord(context, format, list, listOutput(context));
  });

  command
    .command('delete')
    .alias('rm')
    .description(
      'Delete a list. Its items and indexes are deleted in the background'
    )
    .argument('<list>', 'The list (id or path name)')
    .option('-y, --yes', "Don't ask for confirmation")
    .action(async (listId: string, options: { yes?: boolean }) => {
      const jsonpad = context.createClient();
      let question = `Delete the list ${listId}?`;

      // Only look up what's being deleted when there's someone to show it to
      if (!options.yes && canPrompt(context)) {
        const [list, indexes] = await request(context, () =>
          Promise.all([
            jsonpad.fetchList(listId),
            jsonpad.fetchIndexes(listId, { limit: 1 }),
          ])
        );
        question = `Delete the list ${list.pathName || list.id}, with ${
          list.itemCount === 1
            ? '1 item'
            : `${formatNumber(list.itemCount ?? 0)} items`
        } and ${indexes.total === 1 ? '1 index' : `${indexes.total} indexes`}? This can't be undone.`;
      }

      await confirm(context, { question, yes: options.yes });
      await request(context, () => jsonpad.deleteList(listId));

      context.error(
        `Deleted the list ${context.colours.bold(listId)}. Its items and indexes are being deleted in the background`
      );
    });

  addOutputOptions(
    command
      .command('search')
      .description(
        "Search a list's items, using the indexes that allow searching"
      )
      .argument('<list>', 'The list (id or path name)')
      .argument('<query>', 'What to search for, 3 to 100 characters')
      .option('--include-items', 'Include the items, not just their ids')
      .option(
        '--include-data',
        "With --include-items, include each item's data"
      )
      .option(
        '--include-guarded',
        'Include guarded values in the item data, for items the identity making the request owns'
      )
  ).action(
    async (
      listId: string,
      query: string,
      options: OutputOptions & {
        includeItems?: boolean;
        includeData?: boolean;
        includeGuarded?: boolean;
      }
    ) => {
      const format = resolveOutputFormat(context, options);

      // The API's own error for this is a raw validation error
      if (query.length < 3 || query.length > 100) {
        throw new CliError(
          'The search query must be from 3 to 100 characters long'
        );
      }

      const jsonpad = context.createClient();
      const results = await request(context, () =>
        jsonpad.searchList(
          listId,
          query,
          removeUndefined({
            includeItems: options.includeItems,
            includeData: options.includeData,
            includeGuarded: options.includeGuarded,
          })
        )
      );
      const idOf = (result: SearchResult) =>
        'item' in result ? result.item.id : result.id;

      printRecords(context, format, results, {
        id: idOf,
        columns: [
          {
            header: 'RELEVANCE',
            value: result => result.relevance.toFixed(3),
          },
          { header: 'ID', value: idOf },
          ...(options.includeItems
            ? [
                {
                  header: 'DESCRIPTION',
                  value: (result: SearchResult) =>
                    ('item' in result && result.item.description) || '-',
                },
              ]
            : []),
        ],
        empty: 'Nothing found',
      });
    }
  );

  const target = {
    arguments: [['<list>', 'The list (id or path name)']] as [string, string][],
  };

  defineStatsCommand(command, context, {
    ...target,
    description: "Show a list's stats: its items, indexes and events, by day",
    fetch: (jsonpad, [listId], parameters) =>
      jsonpad.fetchListStats(listId, parameters),
  });

  defineEventCommands(command, context, {
    ...target,
    noun: 'list',
    types: ['list-created', 'list-updated', 'list-deleted'],
    fetchEvents: (jsonpad, [listId], parameters) =>
      jsonpad.fetchListEvents(listId, parameters),
    fetchEvent: (jsonpad, [listId], eventId, parameters) =>
      jsonpad.fetchListEvent(listId, eventId, parameters),
  });

  return command;
}
