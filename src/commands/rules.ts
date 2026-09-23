import type { Command } from 'commander';
import {
  applyJsonPatch,
  applyMergePatch,
  Evaluation,
  type Operation,
  type RequestAction,
} from '@basementuniverse/jsonpad-rules';
import type { Context } from '../context.ts';
import {
  CliError,
  EXIT_RULE_TESTS_FAILED,
  describeApiError,
} from '../errors.ts';
import { readJsonInput } from '../input.ts';
import {
  checkEngineVersion,
  compileRules,
  defaultTestsFile,
  engineVersion,
  readJsonFile,
  readTextFile,
  runRuleTests,
} from '../rules.ts';
import type { TestWriteRulesRequest, TestWriteRulesResult } from '../sdk.ts';

const ACTIONS = ['create', 'update', 'delete', 'restore'] as const;

type CheckOptions = {
  strict?: boolean;
};

type TestOptions = {
  rules?: string;
  list?: string;
  filter?: string;
  trace?: boolean;
  json?: boolean;
};

type EvalOptions = {
  action: RequestAction;
  list?: string;
  item?: string;
  old?: string;
  new?: string;
  patch?: string;
  merge?: string;
  identity?: string;
  identityId?: string;
  token?: string;
  now?: string;
  pointer?: string;
  trace?: boolean;
  json?: boolean;
};

export function defineRules(command: Command, context: Context): Command {
  command
    .description("Check, test and try out a list's write rules")
    .addHelpText(
      'after',
      `\nRules are checked by the copy of the rules engine built into this CLI\n(version ${engineVersion}), so check and test need no network and don't\ncount against your request allowance. The API always has the final say.\n`
    );

  command
    .command('check')
    .description(
      "Check that a rule file compiles, and show the checker's warnings"
    )
    .argument('<file>', 'The rule file')
    .option('--strict', 'Fail if there are any warnings')
    .action((file: string, options: CheckOptions) =>
      checkRules(context, file, options)
    );

  command
    .command('test')
    .description('Run a rule set against its tests')
    .argument('[rules]', 'The rule file (not needed with --list)')
    .argument(
      '[tests]',
      "The test file (default: the rule file with .tests.json, or the list's stored tests with --list)"
    )
    .option('--rules <file>', 'The rule file to test against --list')
    .option(
      '--list <list>',
      "Test against the API, using the list's stored rules and tests unless they're given"
    )
    .option('--filter <text>', 'Only tests whose name contains this text')
    .option('--trace', 'Show how each rule was evaluated for a failing test')
    .option('--json', 'Print the results as JSON')
    .action(
      (
        rules: string | undefined,
        tests: string | undefined,
        options: TestOptions
      ) => testRules(context, rules, tests, options)
    );

  command
    .command('eval')
    .description(
      'Check one write against a rule set, and show what each rule did'
    )
    .argument('[rules]', 'The rule file (not needed with --list)')
    .requiredOption(
      '--action <action>',
      `What the write does: ${ACTIONS.join(', ')}`
    )
    .option(
      '--list <list>',
      "Use the list's stored rules, and check with the API"
    )
    .option('--item <item>', 'Take the old data from this item (needs --list)')
    .option('--old <json>', 'The data before the write (@file, - for stdin)')
    .option('--new <json>', 'The data after the write (@file, - for stdin)')
    .option('--patch <json>', 'A JSON Patch applied to the old data')
    .option('--merge <json>', 'A JSON merge patch applied to the old data')
    .option('--identity <json>', 'The identity making the write')
    .option(
      '--identity-id <id>',
      'An existing identity making the write (needs --list)'
    )
    .option(
      '--token <json>',
      'The token making the write, e.g. \'{"tags":["writer"]}\''
    )
    .option('--now <date>', 'The time of the write (ISO 8601)')
    .option(
      '--pointer <pointer>',
      'The JSON pointer, for writes to part of an item'
    )
    .option('--trace', 'Show every expression that was evaluated')
    .option('--json', 'Print the result as JSON')
    .action((rules: string | undefined, options: EvalOptions) =>
      evalRules(context, rules, options)
    );

  return command;
}

async function checkRules(
  context: Context,
  file: string,
  options: CheckOptions
): Promise<void> {
  compileRules(context, readTextFile(context, file, 'the rule file'), file, {
    strict: options.strict,
  });

  context.log(`${context.colours.green('✓')} ${file} compiles`);
}

async function testRules(
  context: Context,
  rulesFile: string | undefined,
  testsFile: string | undefined,
  options: TestOptions
): Promise<void> {
  const file = rulesFile ?? options.rules;

  if (options.list) {
    return testAgainstApi(context, file, testsFile, options);
  }

  if (!file) {
    throw new CliError('Give a rule file, or --list to test against the API');
  }

  const ruleSet = compileRules(
    context,
    readTextFile(context, file, 'the rule file'),
    file,
    { quiet: options.json }
  );
  const tests = testsFile ?? defaultTestsFile(file);

  runRuleTests(
    context,
    ruleSet,
    readJsonFile(context, tests, 'the test file'),
    tests,
    { filter: options.filter, trace: options.trace, json: options.json }
  );
}

/**
 * Run the same tests through the API, so the server agrees with this CLI
 */
async function testAgainstApi(
  context: Context,
  rulesFile: string | undefined,
  testsFile: string | undefined,
  options: TestOptions
): Promise<void> {
  const jsonpad = context.createClient();
  const rules = rulesFile
    ? readTextFile(context, rulesFile, 'the rule file')
    : undefined;

  let list;
  try {
    list = await jsonpad.fetchList(options.list!);
  } catch (error) {
    throw new CliError(describeApiError(error));
  }

  const document = testsFile
    ? readJsonFile(context, testsFile, 'the test file')
    : list.rulesTests;

  if (!document) {
    throw new CliError(
      `List "${options.list}" has no stored rule tests: give a test file`
    );
  }

  const { tests, identities, fixtures, defaults } = document as {
    tests: Record<string, any>[];
    identities?: Record<string, any>;
    fixtures?: Record<string, any>;
    defaults?: Record<string, any>;
  };
  const resolve = (value: unknown) =>
    typeof value === 'string' && fixtures && value in fixtures
      ? fixtures[value]
      : value;

  const { green, red } = context.colours;
  let failed = 0;

  for (const test of tests) {
    if (options.filter && !String(test.name).includes(options.filter)) {
      continue;
    }

    const identity =
      typeof test.identity === 'string'
        ? identities?.[test.identity]
        : (test.identity ?? defaults?.identity);

    let result: TestWriteRulesResult;
    try {
      result = await jsonpad.testListRules(options.list!, {
        rules,
        action: test.action,
        old: resolve(test.old),
        new: resolve(test.new),
        patch: test.patch,
        merge: test.merge,
        identity: identity ?? null,
        token: test.token ?? defaults?.token,
        now: test.now ?? defaults?.now,
        pointer: test.pointer,
      } as TestWriteRulesRequest);
    } catch (error) {
      throw new CliError(describeApiError(error));
    }

    checkEngineVersion(context, result.engineVersion);

    const actual = result.allowed
      ? 'allow'
      : result.status === 400 && result.stage === 'require'
        ? 'fail'
        : 'deny';
    const passed =
      typeof test.expect === 'string'
        ? actual === test.expect
        : actual === 'fail' &&
          (result.message ?? '').includes(test.expect.fail);

    if (passed) {
      context.log(`${green('✓')} ${test.name}`);
    } else {
      failed++;
      context.log(
        `${red('✗')} ${test.name} (the API said ${actual}${
          result.message ? `: ${result.message}` : ''
        })`
      );
    }
  }

  if (failed > 0) {
    throw new CliError(
      `${failed} ${failed === 1 ? 'test' : 'tests'} failed against the API`,
      EXIT_RULE_TESTS_FAILED
    );
  }

  context.log(`\n${green('All tests passed against the API')}`);
}

async function evalRules(
  context: Context,
  rulesFile: string | undefined,
  options: EvalOptions
): Promise<void> {
  if (!ACTIONS.includes(options.action as (typeof ACTIONS)[number])) {
    throw new CliError(`--action must be one of: ${ACTIONS.join(', ')}`);
  }

  const read = async (name: keyof EvalOptions) =>
    options[name] === undefined
      ? undefined
      : await readJsonInput(context, `--${name}`, options[name] as string);

  const [oldData, newData, patch, merge, identity, token] = await Promise.all([
    read('old'),
    read('new'),
    read('patch'),
    read('merge'),
    read('identity'),
    read('token'),
  ]);

  if (options.list) {
    return evalWithApi(context, rulesFile, options, {
      old: oldData,
      new: newData,
      patch,
      merge,
      identity,
      token,
    });
  }

  if (!rulesFile) {
    throw new CliError('Give a rule file, or --list to check with the API');
  }
  if (options.item || options.identityId) {
    throw new CliError('--item and --identity-id need --list');
  }

  const ruleSet = compileRules(
    context,
    readTextFile(context, rulesFile, 'the rule file'),
    rulesFile,
    { quiet: options.json }
  );
  const operation: Operation =
    options.action === 'restore' ? 'update' : options.action;
  const now = options.now ? new Date(options.now) : new Date();

  let after: unknown = newData ?? null;
  if (patch !== undefined) {
    after = applyJsonPatch(oldData ?? null, patch as any);
  } else if (merge !== undefined) {
    after = applyMergePatch(oldData ?? null, merge);
  }

  const evaluation = new Evaluation(ruleSet, {
    operation,
    trace: 'values',
    context: {
      old: oldData ?? null,
      new: after,
      oldItem:
        operation === 'create'
          ? null
          : {
              id: 'item',
              identityId: ((identity as Record<string, any>)?.id ?? null) as
                string | null,
            },
      newItem:
        operation === 'delete'
          ? null
          : {
              id: 'item',
              identityId: ((identity as Record<string, any>)?.id ?? null) as
                string | null,
            },
      identity: (identity as any) ?? null,
      token: (token as any) ?? { id: 'token', tags: [] },
      list: { id: 'list', pathName: 'list', name: 'list' },
      request: { action: options.action, pointer: options.pointer ?? null },
      now,
    },
  });
  const decision = evaluation.decision();

  if (options.json) {
    context.log(JSON.stringify(decision, null, 2));
  } else {
    printDecision(
      context,
      {
        allowed: decision.allowed,
        stage: decision.stage,
        status: decision.status,
        message: decision.message,
        statement: decision.statement
          ? {
              index: decision.statement.index,
              kind: decision.statement.kind,
              label: decision.statement.label,
              line: decision.statement.span.line,
            }
          : null,
        budget: decision.budget,
        statements: decision.statements.map(statement => ({
          kind: statement.kind,
          label: statement.label,
          line: statement.span.line,
          result: statement.result,
          error: statement.error,
        })),
      },
      options.trace
    );
  }

  if (!decision.allowed) {
    throw new CliError(
      decision.stage === 'require'
        ? `The write fails: ${decision.message}`
        : 'The write is denied by the rules',
      EXIT_RULE_TESTS_FAILED
    );
  }
}

async function evalWithApi(
  context: Context,
  rulesFile: string | undefined,
  options: EvalOptions,
  write: Record<string, unknown>
): Promise<void> {
  const jsonpad = context.createClient();
  let result: TestWriteRulesResult;

  try {
    result = await jsonpad.testListRules(options.list!, {
      rules: rulesFile
        ? readTextFile(context, rulesFile, 'the rule file')
        : undefined,
      action: options.action,
      itemId: options.item,
      identityId: options.identityId,
      now: options.now,
      pointer: options.pointer,
      ...write,
    } as TestWriteRulesRequest);
  } catch (error) {
    throw new CliError(describeApiError(error));
  }

  checkEngineVersion(context, result.engineVersion);

  if (options.json) {
    context.log(JSON.stringify(result, null, 2));
  } else {
    printDecision(
      context,
      {
        allowed: result.allowed,
        stage: result.stage,
        status: result.status,
        message: result.message,
        statement: result.statement,
        budget: result.budget,
        statements: result.statements.map(
          (statement: TestWriteRulesResult['statements'][number]) => ({
            kind: statement.kind,
            label: statement.label,
            line: statement.line,
            result: statement.result,
            error: statement.error,
          })
        ),
      },
      options.trace
    );
  }

  if (!result.allowed) {
    throw new CliError(
      result.stage === 'require'
        ? `The write fails: ${result.message}`
        : `The write is ${result.stage === 'schema' ? 'invalid' : 'denied by the rules'}`,
      EXIT_RULE_TESTS_FAILED
    );
  }
}

type Decision = {
  allowed: boolean;
  stage: string;
  status: number;
  message: string | null;
  statement: {
    index: number;
    kind: string;
    label: string | null;
    line: number;
  } | null;
  budget: { used: number; limit: number };
  statements: {
    kind: string;
    label: string | null;
    line: number;
    result: boolean;
    error: string | null;
  }[];
};

function printDecision(
  context: Context,
  decision: Decision,
  trace?: boolean
): void {
  const { green, red, yellow, dim, bold } = context.colours;

  context.log(
    decision.allowed
      ? `${green('allowed')}${
          decision.statement
            ? dim(
                ` by ${decision.statement.kind}${
                  decision.statement.label
                    ? ` "${decision.statement.label}"`
                    : ''
                } on line ${decision.statement.line}`
              )
            : ''
        }`
      : `${red(decision.stage === 'require' ? 'failed' : 'denied')} ${dim(
          `(${decision.status}, at the ${decision.stage} stage)`
        )}${decision.message ? `: ${bold(decision.message)}` : ''}`
  );

  if (trace || !decision.allowed) {
    for (const statement of decision.statements) {
      const outcome = statement.error
        ? yellow(`error: ${statement.error}`)
        : statement.result
          ? green('true')
          : dim('false');
      context.log(
        `  ${dim(`line ${statement.line}`)} ${statement.kind}${
          statement.label ? ` "${statement.label}"` : ''
        }: ${outcome}`
      );
    }
  }

  context.log(
    dim(`\n${decision.budget.used} of ${decision.budget.limit} budget used`)
  );
}
