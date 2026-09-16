import { Option, type Command } from 'commander';
import type { Context } from '../context.ts';
import { parseTimeout, waitForIndex } from '../indexes.ts';
import { canPrompt, confirm } from '../input.ts';
import {
  addOutputOptions,
  formatFlags,
  formatTimestamp,
  printRecord,
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
  readBody,
  removeUndefined,
  printPages,
  request,
  type AllOptions,
  type PagingOptions,
} from '../resources.ts';
import type { Index, JSONPad } from '../sdk.ts';
import { defineEventCommands, defineStatsCommand } from './history.ts';
import { defineRebuildIndex } from './rebuild-index.ts';

const FLAGS = ['alias', 'sorting', 'filtering', 'searching', 'guard'] as const;

const FLAG_DESCRIPTIONS: Record<(typeof FLAGS)[number], [string, string]> = {
  alias: [
    "Items can be fetched by this index's value, in place of their id",
    'Not an alias',
  ],
  sorting: [
    'Items can be ordered by this index',
    "Items can't be ordered by it",
  ],
  filtering: [
    'Items can be filtered by this index',
    "Items can't be filtered by it",
  ],
  searching: [
    "This index's values are included in searches",
    'Not included in searches',
  ],
  guard: [
    'The value is removed from item data returned with a token',
    'Not a guard',
  ],
};

const VALUE_TYPES = ['string', 'number', 'date'];

const ORDER_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'pathName',
  'valueType',
  ...FLAGS,
  'defaultOrderDirection',
  'activated',
];

type IndexFields = {
  name?: string;
  pathName?: string;
  description?: string;
  tags?: string[];
  pointer?: string;
  valueType?: string;
  defaultOrderDirection?: string;
  data?: string;
} & Partial<Record<(typeof FLAGS)[number], boolean>>;

type WaitOptions = { wait?: boolean; timeout?: string };

export function buildStatus(context: Context, index: Index): string {
  const { green, yellow, red } = context.colours;

  switch (index.buildStatus) {
    case 'ready':
      return green('ready');
    case 'building':
      return yellow('building');
    case 'failed':
      return red('failed');
    default:
      return String(index.buildStatus);
  }
}

function indexOutput(
  context: Context
): RecordOutput<Index> & RecordsOutput<Index> {
  const { dim } = context.colours;

  return {
    id: index => index.id,
    details: index => [
      ['ID', index.id],
      ['Path name', index.pathName],
      ['Name', index.name || dim('(none)')],
      ['Description', index.description || dim('(none)')],
      ['Tags', index.tags?.length ? index.tags.join(', ') : dim('(none)')],
      ['Pointer', index.pointer],
      ['Value type', index.valueType],
      ['Flags', formatFlags(index, [...FLAGS])],
      ['Order', index.defaultOrderDirection],
      ['Status', buildStatus(context, index)],
      ['Created', formatTimestamp(index.createdAt)],
      ['Updated', formatTimestamp(index.updatedAt)],
    ],
    columns: [
      { header: 'ID', value: index => index.id },
      { header: 'PATH NAME', value: index => index.pathName },
      { header: 'POINTER', value: index => index.pointer },
      { header: 'TYPE', value: index => index.valueType },
      { header: 'FLAGS', value: index => formatFlags(index, [...FLAGS]) },
      { header: 'STATUS', value: index => buildStatus(context, index) },
    ],
    empty: 'No indexes',
  };
}

function addIndexFieldOptions(command: Command): Command {
  command
    .option('--name <name>', 'The name')
    .option(
      '--path-name <path name>',
      'The path name, used to filter and order items, and in place of the id'
    )
    .option('--description <text>', 'The description');
  addTagsOption(command);
  command
    .option(
      '--pointer <pointer>',
      'The JSON pointer to the value in item data, e.g. /title'
    )
    .addOption(
      new Option('--value-type <type>', 'The type of value').choices(
        VALUE_TYPES
      )
    )
    .addOption(
      new Option(
        '--default-order-direction <direction>',
        'The direction items are ordered in by default'
      ).choices(['asc', 'desc'])
    );

  for (const flag of FLAGS) {
    const [description, negated] = FLAG_DESCRIPTIONS[flag];
    addBooleanOption(command, flag, description, negated);
  }

  return command
    .option(
      '--data <json>',
      'The whole index as a JSON object (JSON, @file or - for stdin); the options above take precedence'
    )
    .option('--wait', 'Wait for the index to be built, if it needs building')
    .option('--timeout <seconds>', 'How long --wait waits (default 600)');
}

function indexBody(context: Context, options: IndexFields) {
  return readBody(context, options.data, {
    name: options.name,
    pathName: options.pathName,
    description: options.description,
    tags: options.tags,
    pointer: options.pointer,
    valueType: options.valueType,
    defaultOrderDirection: options.defaultOrderDirection,
    ...Object.fromEntries(FLAGS.map(flag => [flag, options[flag]])),
  });
}

/**
 * After creating or changing an index, wait for it to build if asked to
 */
async function waitIfBuilding(
  context: Context,
  jsonpad: JSONPad,
  list: string,
  index: Index,
  options: WaitOptions
): Promise<Index> {
  if (!options.wait || index.buildStatus !== 'building') {
    return index;
  }

  return waitForIndex(
    context,
    jsonpad,
    list,
    index.pathName || index.id,
    parseTimeout(options.timeout)
  );
}

export function defineIndexes(command: Command, context: Context): Command {
  command.description("Create, view, change and delete a list's indexes");

  const list = command
    .command('list', { isDefault: true })
    .alias('ls')
    .description("List a list's indexes (the default when no command is given)")
    .argument('<list>', 'The list (id or path name)')
    .option('--name <name>', 'Only indexes whose name contains this')
    .option(
      '--path-name <path name>',
      'Only indexes whose path name contains this'
    )
    .addOption(
      new Option('--value-type <type>', 'Only indexes of this type').choices(
        VALUE_TYPES
      )
    );
  addBooleanOption(list, 'alias', 'Only the alias index', 'Only other indexes');
  addBooleanOption(list, 'guard', 'Only guard indexes', 'Only other indexes');
  addTaggedOption(list);
  addAllOption(list);
  addPagingOptions(list, { choices: ORDER_FIELDS });
  addOutputOptions(list).action(
    async (
      listId: string,
      options: PagingOptions &
        AllOptions &
        OutputOptions &
        IndexFields & { tagged?: string[] }
    ) => {
      const jsonpad = context.createClient();
      await printPages(
        context,
        options,
        paging =>
          jsonpad.fetchIndexes(
            listId,
            removeUndefined({
              ...paging,
              name: options.name,
              pathName: options.pathName,
              valueType: options.valueType,
              alias: options.alias,
              guard: options.guard,
              tagged: options.tagged,
            }) as Parameters<typeof jsonpad.fetchIndexes>[1]
          ),
        indexOutput(context)
      );
    }
  );

  addOutputOptions(
    command
      .command('get')
      .description('Show an index')
      .argument('<list>', 'The list (id or path name)')
      .argument('<index>', 'The index (id or path name)')
  ).action(async (listId: string, indexId: string, options: OutputOptions) => {
    const format = resolveOutputFormat(context, options);
    const jsonpad = context.createClient();
    const index = await request(context, () =>
      jsonpad.fetchIndex(listId, indexId)
    );

    printRecord(context, format, index, indexOutput(context));
  });

  addOutputOptions(
    addIndexFieldOptions(
      command
        .command('create')
        .description(
          "Create an index. It builds in the background, and until it has built it can't be used to filter, order or search items"
        )
        .argument('<list>', 'The list (id or path name)')
    )
  ).action(
    async (
      listId: string,
      options: IndexFields & WaitOptions & OutputOptions
    ) => {
      const format = resolveOutputFormat(context, options);
      const body = await indexBody(context, options);
      const jsonpad = context.createClient();
      const created = await request(context, () =>
        jsonpad.createIndex(listId, body)
      );
      const index = await waitIfBuilding(
        context,
        jsonpad,
        listId,
        created,
        options
      );

      printRecord(context, format, index, indexOutput(context));
    }
  );

  addOutputOptions(
    addIndexFieldOptions(
      command
        .command('update')
        .description(
          "Change an index. Fields that aren't given are left as they are. Changing the pointer rebuilds the index"
        )
        .argument('<list>', 'The list (id or path name)')
        .argument('<index>', 'The index (id or path name)')
    )
  ).action(
    async (
      listId: string,
      indexId: string,
      options: IndexFields & WaitOptions & OutputOptions
    ) => {
      const format = resolveOutputFormat(context, options);
      const body = await indexBody(context, options);
      const jsonpad = context.createClient();
      const updated = await request(context, () =>
        jsonpad.updateIndex(listId, indexId, body)
      );
      const index = await waitIfBuilding(
        context,
        jsonpad,
        listId,
        updated,
        options
      );

      printRecord(context, format, index, indexOutput(context));
    }
  );

  command
    .command('delete')
    .alias('rm')
    .description('Delete an index')
    .argument('<list>', 'The list (id or path name)')
    .argument('<index>', 'The index (id or path name)')
    .option('-y, --yes', "Don't ask for confirmation")
    .action(
      async (listId: string, indexId: string, options: { yes?: boolean }) => {
        const jsonpad = context.createClient();
        let question = `Delete the index ${listId}/${indexId}?`;

        if (!options.yes && canPrompt(context)) {
          const index = await request(context, () =>
            jsonpad.fetchIndex(listId, indexId)
          );
          const warnings = [
            ...(index.alias
              ? [
                  "It's the list's alias index, so items can't be fetched by alias without it.",
                ]
              : []),
            ...(index.guard
              ? [
                  "It's a guard index, so its values will be returned in item data again.",
                ]
              : []),
          ];

          question = [
            ...warnings.map(warning => context.colours.yellow(warning)),
            `Delete the index ${listId}/${index.pathName}?`,
          ].join('\n');
        }

        await confirm(context, { question, yes: options.yes });
        await request(context, () => jsonpad.deleteIndex(listId, indexId));

        context.error(
          `Deleted the index ${context.colours.bold(`${listId}/${indexId}`)}`
        );
      }
    );

  // The same as jsonpad rebuild-index
  defineRebuildIndex(command.command('rebuild'), context);

  command
    .command('wait')
    .description('Wait for an index to finish building')
    .argument('<list>', 'The list (id or path name)')
    .argument('<index>', 'The index (id or path name)')
    .option('--timeout <seconds>', 'How long to wait (default 600)')
    .action(
      async (
        listId: string,
        indexId: string,
        options: { timeout?: string }
      ) => {
        const jsonpad = context.createClient();

        await waitForIndex(
          context,
          jsonpad,
          listId,
          indexId,
          parseTimeout(options.timeout)
        );
      }
    );

  const target = {
    arguments: [
      ['<list>', 'The list (id or path name)'],
      ['<index>', 'The index (id or path name)'],
    ] as [string, string][],
  };

  defineStatsCommand(command, context, {
    ...target,
    description: "Show an index's events, by day",
    fetch: (jsonpad, [listId, indexId], parameters) =>
      jsonpad.fetchIndexStats(listId, indexId, parameters),
  });

  defineEventCommands(command, context, {
    ...target,
    noun: 'index',
    types: [
      'index-created',
      'index-updated',
      'index-deleted',
      'index-built',
      'index-build-failed',
      'index-build-requested',
    ],
    fetchEvents: (jsonpad, [listId, indexId], parameters) =>
      jsonpad.fetchIndexEvents(listId, indexId, parameters),
    fetchEvent: (jsonpad, [listId, indexId], eventId, parameters) =>
      jsonpad.fetchIndexEvent(listId, indexId, eventId, parameters),
  });

  return command;
}
