import type { Command } from 'commander';
import type { Context } from '../context.ts';
import { CliError, describeApiError, EXIT_FLOW_FAILED } from '../errors.ts';
import {
  compileFlow,
  defaultFlowTestsFile,
  engineVersion,
  runFlowTests,
} from '../flows.ts';
import { readJsonInput } from '../input.ts';
import { readJsonFile } from '../rules.ts';
import { FlowError, type FlowResponse } from '../sdk.ts';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

type CheckOptions = {
  strict?: boolean;
};

type TestOptions = {
  filter?: string;
  trace?: boolean;
  json?: boolean;
};

type RunOptions = {
  input?: string;
  method?: string;
  public?: boolean;
  json?: boolean;
};

export function defineFlows(command: Command, context: Context): Command {
  command
    .description('Check, test and run flows')
    .addHelpText(
      'after',
      `\nFlows are checked and tested by the copy of the flows engine built into this\nCLI (version ${engineVersion}), so check and test need no network and don't count\nagainst your request allowance. The API always has the final say.\n\nTo create and update flows, declare them in your schema document (see\nsync-schema) with flowFile and flowTestsFile.\n`
    );

  command
    .command('check')
    .description(
      "Check that a flow file compiles, and show the checker's warnings"
    )
    .argument('<file>', 'The flow file (a JSON flow document)')
    .option('--strict', 'Fail if there are any warnings')
    .action((file: string, options: CheckOptions) =>
      checkFlow(context, file, options)
    );

  command
    .command('test')
    .description("Run a flow's tests, against an in-memory copy of your data")
    .argument('<file>', 'The flow file')
    .argument(
      '[tests]',
      'The test file (default: the flow file with .tests.json, e.g. deal-card.flow.json and deal-card.tests.json)'
    )
    .option('--filter <text>', 'Only tests whose name contains this text')
    .option('--trace', 'Show every node of a failing test')
    .option('--json', 'Print the results as JSON')
    .action((file: string, tests: string | undefined, options: TestOptions) =>
      testFlow(context, file, tests, options)
    );

  command
    .command('run')
    .description(
      'Call an endpoint flow, e.g. jsonpad flows run create-order --input \'{"productId":"p1"}\''
    )
    .argument('<path>', "The flow's endpoint path, or its id with --public")
    .option(
      '--input <json>',
      'The input (the request body, or the query parameters for GET), as JSON (@file, - for stdin)'
    )
    .option('--method <method>', `${METHODS.join(', ')} (default POST)`)
    .option('--public', 'Call a public flow by its id, without a token')
    .option('--json', 'Print the status, body and run id as JSON')
    .action((flowPath: string, options: RunOptions) =>
      runFlow(context, flowPath, options)
    );

  return command;
}

async function checkFlow(
  context: Context,
  file: string,
  options: CheckOptions
): Promise<void> {
  compileFlow(context, readJsonFile(context, file, 'the flow file'), file, {
    strict: options.strict,
  });

  context.log(`${context.colours.green('✓')} ${file} compiles`);
}

async function testFlow(
  context: Context,
  file: string,
  testsFile: string | undefined,
  options: TestOptions
): Promise<void> {
  const flow = compileFlow(
    context,
    readJsonFile(context, file, 'the flow file'),
    file,
    { quiet: options.json }
  );
  const tests = testsFile ?? defaultFlowTestsFile(file);

  await runFlowTests(
    context,
    flow,
    readJsonFile(context, tests, 'the test file'),
    tests,
    options
  );
}

async function runFlow(
  context: Context,
  flowPath: string,
  options: RunOptions
): Promise<void> {
  const method = (options.method ?? 'POST').toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) {
    throw new CliError(`--method must be one of ${METHODS.join(', ')}`);
  }
  const input = options.input
    ? await readJsonInput(context, '--input', options.input)
    : undefined;
  if (
    input !== undefined &&
    (typeof input !== 'object' || input === null || Array.isArray(input))
  ) {
    throw new CliError('--input must be a JSON object');
  }

  const jsonpad = context.createClient();
  let response: FlowResponse;

  try {
    response = options.public
      ? await jsonpad.runPublicFlow(flowPath, input as Record<string, any>, {
          method: method as (typeof METHODS)[number],
        })
      : await jsonpad.runFlow(flowPath, input as Record<string, any>, {
          method: method as (typeof METHODS)[number],
        });
  } catch (error) {
    if (error instanceof FlowError) {
      if (options.json) {
        context.log(
          JSON.stringify(
            {
              status: error.status,
              error: {
                code: error.flowCode,
                message: error.flowMessage,
                node: error.node,
              },
              runId: error.runId,
            },
            null,
            2
          )
        );
      }
      throw new CliError(
        `The flow failed (${error.status}): ${error.flowMessage}${
          error.node ? ` at node "${error.node}"` : ''
        }${error.flowCode ? ` [${error.flowCode}]` : ''}${
          error.runId ? `\nRun ${error.runId}` : ''
        }`,
        EXIT_FLOW_FAILED
      );
    }
    throw new CliError(describeApiError(error));
  }

  if (options.json) {
    context.log(
      JSON.stringify(
        {
          status: response.status,
          body: response.body,
          runId: response.runId,
        },
        null,
        2
      )
    );
    return;
  }

  context.error(
    context.colours.dim(
      `${response.status}${response.runId ? ` (run ${response.runId})` : ''}`
    )
  );
  if (response.body !== null) {
    context.log(JSON.stringify(response.body, null, 2));
  }
}
