import type { ApiRequest, ApiResponse, Scenario } from './harness.ts';

const DOCUMENT = JSON.stringify({
  scope: 'recipe-app',
  lists: {
    recipes: {
      name: 'Recipes',
      indexes: { title: { pointer: '/title', valueType: 'string' } },
    },
  },
});

const files = { 'jsonpad-schema.json': DOCUMENT };

function index(overrides: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    name: 'Title',
    description: '',
    tags: [],
    pathName: 'title',
    pointer: '/title',
    valueType: 'string',
    alias: false,
    sorting: true,
    filtering: true,
    searching: false,
    guard: false,
    defaultOrderDirection: 'asc',
    activated: true,
    buildStatus: 'ready',
    ...overrides,
  };
}

function apiError(status: number, name: string, message: string): ApiResponse {
  return { status, body: { name, code: 1000, message } };
}

/**
 * A refused plan comes back as a 422 whose body is the error plus the plan
 */
function refused(result: Record<string, any>): ApiResponse {
  return {
    status: 422,
    body: {
      name: result.blockedBy.name,
      code: result.blockedBy.code,
      message: result.blockedBy.message,
      ...result,
    },
  };
}

const route =
  (
    routes: Record<string, (request: ApiRequest, count: number) => ApiResponse>
  ) =>
  (request: ApiRequest, count: number): ApiResponse => {
    const handler = routes[`${request.method} ${request.path}`];

    return handler
      ? handler(request, count)
      : apiError(
          404,
          'NOT_FOUND',
          `No route for ${request.method} ${request.path}`
        );
  };

// -----------------------------------------------------------------------------
// sync-schema
// -----------------------------------------------------------------------------

const summary = (overrides: Record<string, number>) => ({
  create: 0,
  update: 0,
  adopt: 0,
  delete: 0,
  noChange: 0,
  error: 0,
  builds: 0,
  destructive: 0,
  ...overrides,
});

const PLAN = {
  syncId: 'sync-1',
  dryRun: true,
  applied: false,
  prune: false,
  scope: 'recipe-app',
  summary: summary({ create: 2, update: 2, adopt: 1, noChange: 2, builds: 2 }),
  changes: [
    {
      resourceType: 'list',
      list: 'recipes',
      action: 'create',
      fields: {
        name: { from: null, to: 'Recipes' },
        description: {
          from: null,
          to: 'A description that is long enough to be shortened when it is shown',
        },
      },
    },
    {
      resourceType: 'index',
      list: 'recipes',
      index: 'title',
      action: 'create',
      fields: { pointer: { from: null, to: '/title' } },
      build: { reason: 'created', items: 0, requiresConfirmation: false },
    },
    {
      resourceType: 'list',
      list: 'ratings',
      listId: 'l2',
      action: 'update',
      fields: { realtime: { from: false, to: true } },
    },
    {
      resourceType: 'index',
      list: 'ratings',
      index: 'score',
      action: 'update',
      fields: { pointer: { from: '/score', to: '/stars' } },
      build: {
        reason: 'pointerChanged',
        items: 1,
        requiresConfirmation: false,
      },
    },
    { resourceType: 'list', list: 'authors', action: 'adopt' },
    { resourceType: 'list', list: 'tags', action: 'no-change' },
    {
      resourceType: 'index',
      list: 'tags',
      index: 'name',
      action: 'no-change',
      warnings: ['The last build of this index failed'],
    },
  ],
  blockedBy: null,
};

const UP_TO_DATE = {
  ...PLAN,
  dryRun: false,
  applied: true,
  summary: summary({ noChange: 2 }),
  changes: [
    { resourceType: 'list', list: 'recipes', action: 'no-change' },
    {
      resourceType: 'index',
      list: 'recipes',
      index: 'title',
      action: 'no-change',
    },
  ],
};

const REBUILD_REFUSED = {
  ...PLAN,
  dryRun: false,
  scope: null,
  summary: summary({ update: 1, builds: 1 }),
  changes: [
    {
      resourceType: 'index',
      list: 'ratings',
      index: 'score',
      action: 'update',
      fields: { pointer: { from: '/score', to: '/stars' } },
      build: {
        reason: 'pointerChanged',
        items: 42,
        requiresConfirmation: true,
      },
    },
  ],
  blockedBy: {
    name: 'SCHEMA_SYNC_REBUILD_NOT_ALLOWED',
    code: 13003,
    message:
      'This sync rebuilds indexes in lists that have items (pass allowRebuild=true to allow this)',
  },
};

const DESTRUCTIVE_REFUSED = {
  ...PLAN,
  prune: true,
  summary: summary({ delete: 2, noChange: 1, destructive: 1 }),
  changes: [
    { resourceType: 'list', list: 'recipes', action: 'no-change' },
    {
      resourceType: 'list',
      list: 'old-recipes',
      action: 'delete',
      delete: { items: 12, indexes: 1, destructive: true },
    },
    {
      resourceType: 'index',
      list: 'recipes',
      index: 'secret',
      action: 'delete',
      delete: { destructive: false },
    },
  ],
  blockedBy: {
    name: 'SCHEMA_SYNC_DESTRUCTIVE_NOT_ALLOWED',
    code: 13004,
    message:
      'This prune deletes lists that have items (pass allowDestructive=true to allow this)',
  },
};

const HAS_ERRORS = {
  ...PLAN,
  dryRun: false,
  summary: summary({ create: 1, error: 1 }),
  changes: [
    { resourceType: 'list', list: 'recipes', action: 'create' },
    {
      resourceType: 'index',
      list: 'recipes',
      index: 'title',
      action: 'error',
      errors: [
        { name: 'VALIDATION_ERROR', code: 1, message: 'pointer is required' },
        { name: 'VALIDATION_ERROR', code: 1, message: 'valueType is invalid' },
      ],
    },
  ],
  blockedBy: {
    name: 'SCHEMA_SYNC_HAS_ERRORS',
    code: 13002,
    message: 'The sync was refused because a change has errors',
  },
};

const APPLIED_WITH_BUILDS = {
  ...PLAN,
  dryRun: false,
  applied: true,
  summary: summary({ create: 2, builds: 2 }),
  changes: [
    {
      resourceType: 'index',
      list: 'recipes',
      index: 'title',
      listId: 'l1',
      indexId: 'i1',
      action: 'create',
      build: {
        reason: 'created',
        items: 3,
        requiresConfirmation: false,
        buildStatus: 'building',
      },
    },
    {
      resourceType: 'index',
      list: 'recipes',
      index: 'author',
      listId: 'l1',
      indexId: 'i2',
      action: 'create',
      build: {
        reason: 'created',
        items: 3,
        requiresConfirmation: false,
        buildStatus: 'building',
      },
    },
    {
      resourceType: 'index',
      list: 'recipes',
      index: 'empty',
      listId: 'l1',
      indexId: 'i3',
      action: 'create',
      build: {
        reason: 'created',
        items: 0,
        requiresConfirmation: false,
        buildStatus: 'ready',
      },
    },
  ],
};

const syncReturns = (response: ApiResponse) =>
  route({ 'POST /sync-schema': () => response });

const syncScenarios: Scenario[] = [
  {
    name: 'sync-schema-missing-file',
    args: ['sync-schema'],
  },
  {
    name: 'sync-schema-missing-named-file',
    args: ['sync-schema', 'schemas/app.json'],
  },
  {
    name: 'sync-schema-invalid-json',
    args: ['sync-schema'],
    files: { 'jsonpad-schema.json': '{ "lists": ' },
  },
  {
    name: 'sync-schema-no-token',
    args: ['sync-schema'],
    files,
    noToken: true,
  },
  {
    name: 'sync-schema-named-file',
    args: ['sync-schema', 'app-schema.json', '--dry-run'],
    files: { 'app-schema.json': DOCUMENT },
    api: syncReturns({ status: 200, body: PLAN }),
  },
  {
    name: 'sync-schema-dry-run',
    args: ['sync-schema', '--dry-run'],
    files,
    api: syncReturns({ status: 200, body: PLAN }),
  },
  {
    name: 'sync-schema-show-unchanged',
    args: ['sync-schema', '--dry-run', '--show-unchanged'],
    files,
    api: syncReturns({ status: 200, body: PLAN }),
  },
  {
    name: 'sync-schema-json',
    args: ['sync-schema', '--dry-run', '--json'],
    files,
    api: syncReturns({ status: 200, body: PLAN }),
  },
  {
    name: 'sync-schema-up-to-date',
    args: ['sync-schema'],
    files,
    api: syncReturns({ status: 200, body: UP_TO_DATE }),
  },
  {
    name: 'sync-schema-nothing-shown',
    args: ['sync-schema'],
    files,
    api: syncReturns({
      status: 200,
      body: { ...UP_TO_DATE, scope: null, changes: [], summary: summary({}) },
    }),
  },
  {
    name: 'sync-schema-applied',
    args: ['sync-schema', '--allow-rebuild', '--prune', '--allow-destructive'],
    files,
    api: syncReturns({
      status: 200,
      body: { ...PLAN, dryRun: false, applied: true, prune: true },
    }),
  },
  {
    name: 'sync-schema-rebuild-refused',
    args: ['sync-schema'],
    files,
    api: syncReturns(refused(REBUILD_REFUSED)),
  },
  {
    name: 'sync-schema-rebuild-refused-dry-run',
    args: ['sync-schema', '--dry-run'],
    files,
    api: syncReturns(refused({ ...REBUILD_REFUSED, dryRun: true })),
  },
  {
    name: 'sync-schema-rebuild-refused-json',
    args: ['sync-schema', '--json'],
    files,
    api: syncReturns(refused(REBUILD_REFUSED)),
  },
  {
    name: 'sync-schema-destructive-refused',
    args: ['sync-schema', '--prune', '--dry-run'],
    files,
    api: syncReturns(refused(DESTRUCTIVE_REFUSED)),
  },
  {
    name: 'sync-schema-has-errors',
    args: ['sync-schema'],
    files,
    api: syncReturns(refused(HAS_ERRORS)),
  },
  {
    name: 'sync-schema-api-error',
    args: ['sync-schema'],
    files,
    api: syncReturns(
      apiError(400, 'VALIDATION_ERROR', 'The schema document is invalid')
    ),
  },
  {
    name: 'sync-schema-api-error-not-json',
    args: ['sync-schema'],
    files,
    api: syncReturns({ status: 502, text: 'Bad gateway' }),
  },
  {
    name: 'sync-schema-applied-no-wait',
    args: ['sync-schema'],
    files,
    api: syncReturns({ status: 200, body: APPLIED_WITH_BUILDS }),
  },
  {
    name: 'sync-schema-wait',
    args: ['sync-schema', '--wait'],
    files,
    api: route({
      'POST /sync-schema': () => ({ status: 200, body: APPLIED_WITH_BUILDS }),
      'GET /lists/l1/indexes/i1': () => ({ status: 200, body: index() }),
      'GET /lists/l1/indexes/i2': () => ({
        status: 200,
        body: index({ id: 'i2', pathName: 'author' }),
      }),
    }),
  },
  {
    name: 'sync-schema-wait-failed',
    args: ['sync-schema', '--wait', '--timeout', '30'],
    files,
    api: route({
      'POST /sync-schema': () => ({ status: 200, body: APPLIED_WITH_BUILDS }),
      'GET /lists/l1/indexes/i1': () => ({
        status: 200,
        body: index({ buildStatus: 'failed' }),
      }),
      'GET /lists/l1/indexes/i2': () => ({ status: 500, text: 'oops' }),
    }),
  },
  {
    name: 'sync-schema-wait-dry-run',
    args: ['sync-schema', '--wait', '--dry-run'],
    files,
    api: syncReturns({ status: 200, body: PLAN }),
  },
  {
    name: 'sync-schema-bad-timeout',
    args: ['sync-schema', '--wait', '--timeout', 'soon'],
    files,
    api: syncReturns({ status: 200, body: APPLIED_WITH_BUILDS }),
  },
];

// -----------------------------------------------------------------------------
// export-schema
// -----------------------------------------------------------------------------

const EXPORT = {
  document: {
    $schema: 'https://api.jsonpad.io/schemas/sync-schema.json',
    scope: 'recipe-app',
    lists: {
      recipes: {
        name: 'Recipes',
        tags: ['recipe-app'],
        indexes: { title: { pointer: '/title', valueType: 'string' } },
      },
      ratings: { name: 'Ratings', tags: ['recipe-app'] },
    },
  },
  warnings: ['List "Untitled" has no path name, so it was left out'],
};

const exportReturns = (response: ApiResponse) =>
  route({ 'GET /sync-schema': () => response });

const exportScenarios: Scenario[] = [
  {
    name: 'export-schema-stdout',
    args: ['export-schema'],
    api: exportReturns({ status: 200, body: EXPORT }),
  },
  {
    name: 'export-schema-filters',
    args: [
      'export-schema',
      '--scope',
      'recipe-app',
      '--tagged',
      'a,b',
      '--tagged',
      'c',
      '--lists',
      ' recipes, ,ratings ',
    ],
    api: exportReturns({ status: 200, body: { ...EXPORT, warnings: [] } }),
  },
  {
    name: 'export-schema-out',
    args: ['export-schema', '--out', 'schema.json'],
    outputs: ['schema.json'],
    api: exportReturns({ status: 200, body: EXPORT }),
  },
  {
    name: 'export-schema-api-error',
    args: ['export-schema'],
    api: exportReturns(
      apiError(403, 'TOKEN_PERMISSION_DENIED', "This token can't sync schemas")
    ),
  },
  {
    name: 'export-schema-no-token',
    args: ['export-schema'],
    noToken: true,
  },
];

// -----------------------------------------------------------------------------
// move-lists
// -----------------------------------------------------------------------------

const MOVE = {
  moveId: 'move-1',
  dryRun: true,
  applied: false,
  scope: 'cookbook-app',
  summary: { move: 1, assign: 1, release: 0, noChange: 1, error: 0 },
  changes: [
    {
      list: 'recipes',
      listId: 'l1',
      action: 'move',
      from: 'recipe-app',
      to: 'cookbook-app',
      indexes: 2,
      fields: { tags: { from: ['recipe-app'], to: ['cookbook-app'] } },
    },
    {
      list: 'ratings',
      listId: 'l2',
      action: 'assign',
      from: null,
      to: 'cookbook-app',
      indexes: 1,
      warnings: ['This list has no indexes the scope manages yet'],
    },
    {
      list: 'authors',
      listId: 'l3',
      action: 'no-change',
      from: 'cookbook-app',
      to: 'cookbook-app',
      indexes: 0,
    },
  ],
  warnings: [],
  blockedBy: null,
};

const RELEASE = {
  ...MOVE,
  dryRun: false,
  applied: true,
  scope: null,
  summary: { move: 0, assign: 0, release: 1, noChange: 0, error: 0 },
  changes: [
    {
      list: 'recipes',
      listId: 'l1',
      action: 'release',
      from: 'recipe-app',
      to: null,
      indexes: 2,
    },
  ],
};

const MOVE_REFUSED = {
  ...MOVE,
  dryRun: false,
  summary: { move: 1, assign: 0, release: 0, noChange: 0, error: 1 },
  changes: [
    MOVE.changes[0],
    {
      list: 'missing',
      action: 'error',
      errors: [
        { name: 'LIST_NOT_FOUND', code: 3001, message: 'List not found' },
      ],
    },
  ],
  blockedBy: {
    name: 'SCHEMA_SYNC_MOVE_HAS_ERRORS',
    code: 13010,
    message: 'The move was refused because a change has errors',
  },
};

const moveReturns = (response: ApiResponse) =>
  route({ 'POST /sync-schema/move': () => response });

const moveScenarios: Scenario[] = [
  {
    name: 'move-lists-no-destination',
    args: ['move-lists', 'recipes'],
  },
  {
    name: 'move-lists-both-destinations',
    args: ['move-lists', 'recipes', '--to', 'cookbook-app', '--release'],
  },
  {
    name: 'move-lists-no-lists',
    args: ['move-lists', '--to', 'cookbook-app'],
  },
  {
    name: 'move-lists-lists-and-from-scope',
    args: ['move-lists', 'recipes', '--from-scope', 'a', '--to', 'b'],
  },
  {
    name: 'move-lists-no-token',
    args: ['move-lists', 'recipes', '--to', 'cookbook-app'],
    noToken: true,
  },
  {
    name: 'move-lists-dry-run',
    args: [
      'move-lists',
      'recipes',
      'ratings',
      'authors',
      '--to',
      'cookbook-app',
      '--dry-run',
    ],
    api: moveReturns({ status: 200, body: MOVE }),
  },
  {
    name: 'move-lists-applied',
    args: ['move-lists', '--from-scope', 'recipe-app', '--to', 'cookbook-app'],
    api: moveReturns({
      status: 200,
      body: { ...MOVE, dryRun: false, applied: true },
    }),
  },
  {
    name: 'move-lists-release',
    args: ['move-lists', 'recipes', '--release'],
    api: moveReturns({ status: 200, body: RELEASE }),
  },
  {
    name: 'move-lists-json',
    args: ['move-lists', 'recipes', '--release', '--json'],
    api: moveReturns({ status: 200, body: RELEASE }),
  },
  {
    name: 'move-lists-nothing',
    args: ['move-lists', '--from-scope', 'nope', '--to', 'cookbook-app'],
    api: moveReturns({
      status: 200,
      body: {
        ...MOVE,
        dryRun: false,
        applied: true,
        summary: { move: 0, assign: 0, release: 0, noChange: 0, error: 0 },
        changes: [],
      },
    }),
  },
  {
    name: 'move-lists-warnings-only',
    args: ['move-lists', '--from-scope', 'nope', '--to', 'cookbook-app'],
    api: moveReturns({
      status: 200,
      body: {
        ...MOVE,
        summary: { move: 0, assign: 0, release: 0, noChange: 0, error: 0 },
        changes: [],
        warnings: ['The scope "nope" doesn\'t manage any lists'],
      },
    }),
  },
  {
    name: 'move-lists-refused',
    args: ['move-lists', 'recipes', 'missing', '--to', 'cookbook-app'],
    api: moveReturns(refused(MOVE_REFUSED)),
  },
  {
    name: 'move-lists-refused-dry-run',
    args: [
      'move-lists',
      'recipes',
      'missing',
      '--to',
      'cookbook-app',
      '--dry-run',
    ],
    api: moveReturns(refused({ ...MOVE_REFUSED, dryRun: true })),
  },
  {
    name: 'move-lists-api-error',
    args: ['move-lists', 'recipes', '--to', 'Not A Valid Scope'],
    api: moveReturns(apiError(400, 'VALIDATION_ERROR', 'scope is invalid')),
  },
];

// -----------------------------------------------------------------------------
// rebuild-index
// -----------------------------------------------------------------------------

const rebuildScenarios: Scenario[] = [
  {
    name: 'rebuild-index',
    args: ['rebuild-index', 'recipes', 'title'],
    api: route({
      'POST /lists/recipes/indexes/title/rebuild': () => ({
        status: 200,
        body: index({ buildStatus: 'building' }),
      }),
    }),
  },
  {
    name: 'rebuild-index-wait',
    args: ['rebuild-index', 'recipes', 'title', '--wait'],
    api: route({
      'POST /lists/recipes/indexes/title/rebuild': () => ({
        status: 200,
        body: index({ buildStatus: 'building' }),
      }),
      'GET /lists/recipes/indexes/i1': () => ({ status: 200, body: index() }),
    }),
  },
  {
    name: 'rebuild-index-wait-timeout',
    args: ['rebuild-index', 'recipes', 'title', '--wait', '--timeout', '0.1'],
    api: route({
      'POST /lists/recipes/indexes/title/rebuild': () => ({
        status: 200,
        body: index({ buildStatus: 'building' }),
      }),
      'GET /lists/recipes/indexes/i1': () => ({
        status: 200,
        body: index({ buildStatus: 'building' }),
      }),
    }),
  },
  {
    name: 'rebuild-index-bad-timeout',
    args: ['rebuild-index', 'recipes', 'title', '--wait', '--timeout', '0'],
    api: route({
      'POST /lists/recipes/indexes/title/rebuild': () => ({
        status: 200,
        body: index({ buildStatus: 'building' }),
      }),
    }),
  },
  {
    name: 'rebuild-index-not-failed',
    args: ['rebuild-index', 'recipes', 'title'],
    api: route({
      'POST /lists/recipes/indexes/title/rebuild': () =>
        apiError(
          409,
          'INDEX_BUILD_NOT_FAILED',
          'Only an index whose last build failed can be rebuilt'
        ),
    }),
  },
  {
    name: 'rebuild-index-no-token',
    args: ['rebuild-index', 'recipes', 'title'],
    noToken: true,
  },
];

// -----------------------------------------------------------------------------
// Help, version and argument errors (commander's own output, so only the exit
// codes are compared)
// -----------------------------------------------------------------------------

const generalScenarios: Scenario[] = [
  { name: 'no-arguments', args: [], compare: 'exitCode' },
  { name: 'help', args: ['--help'], compare: 'exitCode' },
  { name: 'help-short', args: ['-h'], compare: 'exitCode' },
  { name: 'help-command', args: ['help'], compare: 'exitCode' },
  {
    name: 'command-help',
    args: ['sync-schema', '--help'],
    compare: 'exitCode',
  },
  { name: 'version', args: ['--version'], compare: 'exitCode' },
  { name: 'version-short', args: ['-v'], compare: 'exitCode' },
  { name: 'unknown-command', args: ['sync'], compare: 'exitCode' },
  {
    name: 'unknown-option',
    args: ['sync-schema', '--force'],
    files,
    compare: 'exitCode',
  },
  {
    name: 'missing-option-value',
    args: ['export-schema', '--scope'],
    compare: 'exitCode',
  },
  {
    // parseArgs refused a value starting with a dash, where commander takes it
    // and the command then rejects it
    name: 'negative-option-value',
    args: ['rebuild-index', 'recipes', 'title', '--wait', '--timeout', '-5'],
    compare: 'exitCode',
    api: route({
      'POST /lists/recipes/indexes/title/rebuild': () => ({
        status: 200,
        body: index({ buildStatus: 'building' }),
      }),
    }),
  },
  {
    name: 'rebuild-index-missing-arguments',
    args: ['rebuild-index', 'recipes'],
    compare: 'exitCode',
  },
];

export const scenarios: Scenario[] = [
  ...syncScenarios,
  ...exportScenarios,
  ...moveScenarios,
  ...rebuildScenarios,
  ...generalScenarios,
];

/**
 * The `jsonpad schema ...` commands and `jsonpad indexes rebuild` must behave
 * exactly like the commands ported from the SDK
 */
export const ALIASES: Record<string, string[]> = {
  'sync-schema': ['schema', 'sync'],
  'export-schema': ['schema', 'export'],
  'move-lists': ['schema', 'move'],
  'rebuild-index': ['indexes', 'rebuild'],
};
