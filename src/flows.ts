import path from 'node:path';
import {
  compile,
  runTests,
  version as engineVersion,
  type CompiledFlow,
  type FlowDiagnostic,
  type FlowTestResult,
} from '@basementuniverse/jsonpad-flows';
import type { Context } from './context.ts';
import { CliError, EXIT_TESTS_FAILED } from './errors.ts';
import { readJsonFile } from './rules.ts';

export { engineVersion };

/**
 * Where `flows test` looks for a flow's tests when it isn't told
 */
export function defaultFlowTestsFile(flowFile: string): string {
  return flowFile.replace(/(\.flow)?(\.json)?$/, '.tests.json');
}

/**
 * Print a flow's diagnostics as file: path, with the line and column of the
 * problem inside an expression when there is one
 */
export function printFlowDiagnostics(
  context: Context,
  diagnostics: FlowDiagnostic[],
  file: string
): { errors: number; warnings: number } {
  const { red, yellow, dim } = context.colours;
  let errors = 0;
  let warnings = 0;

  for (const diagnostic of diagnostics) {
    const isError = diagnostic.severity === 'error';
    if (isError) {
      errors++;
    } else {
      warnings++;
    }

    const where = `${file}:${diagnostic.path || '/'}${
      diagnostic.span
        ? `:${diagnostic.span.line}:${diagnostic.span.column}`
        : ''
    }`;
    context.log(
      `${dim(where)} ${isError ? red('error') : yellow('warning')} ${
        diagnostic.message
      } ${dim(`[${diagnostic.code}]`)}`
    );
  }

  return { errors, warnings };
}

/**
 * Compile a flow document, printing its diagnostics. Throws when it doesn't
 * compile
 */
export function compileFlow(
  context: Context,
  document: unknown,
  file: string,
  options: { strict?: boolean; quiet?: boolean } = {}
): CompiledFlow {
  const { flow, diagnostics } = compile(document);
  const { errors, warnings } = options.quiet
    ? {
        errors: diagnostics.filter(d => d.severity === 'error').length,
        warnings: 0,
      }
    : printFlowDiagnostics(context, diagnostics, file);

  if (!flow) {
    throw new CliError(
      `${file} has ${errors} ${errors === 1 ? 'error' : 'errors'}`
    );
  }

  if (options.strict && warnings > 0) {
    throw new CliError(
      `${file} has ${warnings} ${warnings === 1 ? 'warning' : 'warnings'} (--strict)`
    );
  }

  return flow;
}

function printFlowTestResult(
  context: Context,
  result: FlowTestResult,
  options: { trace?: boolean }
): void {
  const { green, red, dim } = context.colours;

  if (result.passed) {
    context.log(`${green('✓')} ${result.name}`);
    return;
  }

  context.log(`${red('✗')} ${result.name}`);
  for (const failure of result.failures) {
    context.log(`    ${failure}`);
  }

  if (options.trace && result.run?.trace) {
    for (const entry of result.run.trace) {
      const status =
        entry.status === 'ran'
          ? green('ran')
          : entry.status === 'failed'
            ? red('failed')
            : dim('skipped');
      context.log(
        `    ${dim(entry.id)} ${entry.type}: ${status}${
          entry.port ? dim(` → ${entry.port}`) : ''
        }${entry.error ? ` ${red(entry.error)}` : ''}`
      );
    }
  }
}

/**
 * Run a flow's tests, printing each one, and throw if any of them fail
 */
export async function runFlowTests(
  context: Context,
  flow: CompiledFlow,
  document: unknown,
  file: string,
  options: { filter?: string; trace?: boolean; json?: boolean } = {}
): Promise<void> {
  const run = await runTests(flow, document, {
    filter: options.filter,
    trace: options.trace ? 'values' : 'off',
  });

  if (run.errors.length > 0) {
    throw new CliError(
      [
        `${file} isn't a valid flow test document:`,
        ...run.errors.map(error =>
          error.path
            ? `  ${error.path}: ${error.message}`
            : `  ${error.message}`
        ),
      ].join('\n')
    );
  }

  if (options.json) {
    context.log(
      JSON.stringify(
        {
          passed: run.passed,
          failed: run.failed,
          results: run.results.map(result => ({
            name: result.name,
            passed: result.passed,
            failures: result.failures,
          })),
        },
        null,
        2
      )
    );
  } else {
    for (const result of run.results) {
      printFlowTestResult(context, result, options);
    }

    const { green, red } = context.colours;
    context.log(
      `\n${run.passed} passed, ${
        run.failed > 0 ? red(`${run.failed} failed`) : green('0 failed')
      }`
    );
  }

  if (run.failed > 0) {
    throw new CliError(
      `${run.failed} of ${run.results.length} ${
        run.results.length === 1 ? 'test' : 'tests'
      } failed`,
      EXIT_TESTS_FAILED
    );
  }
}

/**
 * Resolve the CLI-only flowFile and flowTestsFile fields in a schema sync
 * document, relative to the document, into the document and tests the API
 * takes
 */
export function resolveFlowFiles(
  context: Context,
  document: { flows?: Record<string, Record<string, any>> },
  documentFile: string
): void {
  const directory = path.dirname(path.resolve(context.cwd, documentFile));

  for (const [name, flow] of Object.entries(document.flows ?? {})) {
    for (const [field, target] of [
      ['flowFile', 'document'],
      ['flowTestsFile', 'tests'],
    ] as const) {
      const file = flow[field];
      if (file === undefined) {
        continue;
      }

      if (flow[target] !== undefined) {
        throw new CliError(
          `Flow "${name}" has both ${field} and ${target}: use one or the other`
        );
      }

      const resolved = path.relative(
        context.cwd,
        path.resolve(directory, file)
      );
      flow[target] = readJsonFile(
        context,
        resolved,
        `${field} for flow "${name}"`
      );
      delete flow[field];
    }
  }
}

/**
 * Compile and test the flows in a schema sync document, before it's sent
 */
export async function checkDocumentFlows(
  context: Context,
  document: { flows?: Record<string, Record<string, any>> }
): Promise<void> {
  for (const [name, flow] of Object.entries(document.flows ?? {})) {
    if (!flow.document || typeof flow.document !== 'object') {
      continue;
    }

    const where = `flow "${name}"`;
    const compiled = compileFlow(context, { name, ...flow.document }, where);

    if (flow.tests) {
      await runFlowTests(
        context,
        compiled,
        flow.tests,
        `the tests for ${where}`
      );
    }
  }
}
