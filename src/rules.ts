import fs from 'node:fs';
import path from 'node:path';
import {
  compile,
  runTests,
  version as engineVersion,
  type CompiledRuleSet,
  type Diagnostic,
  type RuleTestResult,
} from '@basementuniverse/jsonpad-rules';
import type { Context } from './context.ts';
import { CliError, EXIT_RULE_TESTS_FAILED } from './errors.ts';

export { engineVersion };

/**
 * Where `rules test` looks for a rule set's tests when it isn't told
 */
export function defaultTestsFile(rulesFile: string): string {
  return rulesFile.replace(/(\.[^./\\]+)?$/, '.tests.json');
}

export function readTextFile(
  context: Context,
  file: string,
  what: string
): string {
  try {
    return fs.readFileSync(path.resolve(context.cwd, file), 'utf8');
  } catch (error: any) {
    throw new CliError(
      error.code === 'ENOENT'
        ? `Can't find ${file} (${what})`
        : `Can't read ${file} (${what}): ${error.message}`
    );
  }
}

export function readJsonFile(
  context: Context,
  file: string,
  what: string
): unknown {
  const text = readTextFile(context, file, what);

  try {
    return JSON.parse(text);
  } catch (error: any) {
    throw new CliError(`${file} isn't valid JSON: ${error.message}`);
  }
}

/**
 * Print diagnostics as file:line:column, the way compilers do, so an editor
 * can jump to them
 */
export function printDiagnostics(
  context: Context,
  diagnostics: Diagnostic[],
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

    context.log(
      `${dim(`${file}:${diagnostic.span.line}:${diagnostic.span.column}`)} ${
        isError ? red('error') : yellow('warning')
      } ${diagnostic.message} ${dim(`[${diagnostic.code}]`)}`
    );
  }

  return { errors, warnings };
}

/**
 * Compile rule text, printing its diagnostics. Throws when it doesn't compile
 */
export function compileRules(
  context: Context,
  text: string,
  file: string,
  options: { strict?: boolean; quiet?: boolean } = {}
): CompiledRuleSet {
  const { ruleSet, diagnostics } = compile(text);
  const { errors, warnings } = options.quiet
    ? {
        errors: diagnostics.filter(d => d.severity === 'error').length,
        warnings: 0,
      }
    : printDiagnostics(context, diagnostics, file);

  if (!ruleSet) {
    throw new CliError(
      `${file} has ${errors} ${errors === 1 ? 'error' : 'errors'}`
    );
  }

  if (options.strict && warnings > 0) {
    throw new CliError(
      `${file} has ${warnings} ${warnings === 1 ? 'warning' : 'warnings'} (--strict)`
    );
  }

  return ruleSet;
}

/**
 * Print the result of one test, and its trace if asked for
 */
export function printTestResult(
  context: Context,
  result: RuleTestResult,
  options: { trace?: boolean } = {}
): void {
  const { green, red, dim } = context.colours;
  const describe = (
    outcome: string,
    expectation: RuleTestResult['expected']
  ) => {
    if (typeof expectation === 'object') {
      return `${outcome} (expected the write to fail with "${expectation.fail}")`;
    }
    return `${outcome} (expected ${expectation})`;
  };

  if (result.passed) {
    context.log(`${green('✓')} ${result.name}`);
    return;
  }

  context.log(
    `${red('✗')} ${result.name} ${dim(describe(result.actual, result.expected))}`
  );

  if (result.message) {
    context.log(`    ${result.message}`);
  }

  if (options.trace && result.decision) {
    for (const statement of result.decision.statements) {
      const outcome = statement.error
        ? red(`error: ${statement.error}`)
        : statement.result
          ? green('true')
          : dim('false');
      context.log(
        `    ${dim(`line ${statement.span.line}`)} ${statement.kind}${
          statement.label ? ` "${statement.label}"` : ''
        }: ${outcome}`
      );
    }
  }
}

/**
 * Run a test document against a rule set, printing each test, and throw if
 * any of them fail
 */
export function runRuleTests(
  context: Context,
  ruleSet: CompiledRuleSet,
  document: unknown,
  file: string,
  options: { filter?: string; trace?: boolean; json?: boolean } = {}
): void {
  const run = runTests(ruleSet, document, { filter: options.filter });

  if (run.errors.length > 0) {
    throw new CliError(
      [
        `${file} isn't a valid test document:`,
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
            expected: result.expected,
            actual: result.actual,
            message: result.message,
          })),
        },
        null,
        2
      )
    );
  } else {
    for (const result of run.results) {
      printTestResult(context, result, options);
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
      EXIT_RULE_TESTS_FAILED
    );
  }
}

/**
 * Warn when the server's rules engine isn't the one built into this CLI: a
 * rule set that passes here could still be refused there
 */
export function checkEngineVersion(
  context: Context,
  serverVersion: string | undefined
): void {
  if (!serverVersion) {
    return;
  }

  const [major, minor] = engineVersion.split('.');
  const [serverMajor, serverMinor] = serverVersion.split('.');

  if (major !== serverMajor || minor !== serverMinor) {
    context.error(
      `${context.colours.yellow('warning')}: this CLI has rules engine ${engineVersion}, and the API has ${serverVersion}. The API decides: check your rules with --list if they disagree`
    );
  }
}

/**
 * Resolve the CLI-only rulesFile and rulesTestsFile fields in a schema sync
 * document, relative to the document, into the rules and rulesTests the API
 * takes
 */
export function resolveRuleFiles(
  context: Context,
  document: { lists?: Record<string, Record<string, any>> },
  documentFile: string
): void {
  const directory = path.dirname(path.resolve(context.cwd, documentFile));

  for (const [pathName, list] of Object.entries(document.lists ?? {})) {
    for (const [field, target] of [
      ['rulesFile', 'rules'],
      ['rulesTestsFile', 'rulesTests'],
    ] as const) {
      const file = list[field];
      if (file === undefined) {
        continue;
      }

      if (list[target] !== undefined) {
        throw new CliError(
          `List "${pathName}" has both ${field} and ${target}: use one or the other`
        );
      }

      const resolved = path.relative(
        context.cwd,
        path.resolve(directory, file)
      );
      list[target] =
        target === 'rules'
          ? readTextFile(context, resolved, `${field} for list "${pathName}"`)
          : readJsonFile(context, resolved, `${field} for list "${pathName}"`);
      delete list[field];
    }
  }
}

/**
 * Compile and test the write rules in a schema sync document, before it's
 * sent
 */
export function checkDocumentRules(
  context: Context,
  document: { lists?: Record<string, Record<string, any>> }
): void {
  for (const [pathName, list] of Object.entries(document.lists ?? {})) {
    const rules = Array.isArray(list.rules)
      ? list.rules.join('\n')
      : list.rules;

    if (typeof rules !== 'string' || rules.trim() === '') {
      continue;
    }

    const where = `the rules for list "${pathName}"`;
    const { ruleSet, diagnostics } = compile(rules);
    printDiagnostics(context, diagnostics, where);

    if (!ruleSet) {
      throw new CliError(`${where} don't compile`);
    }

    if (list.rulesTests) {
      runRuleTests(
        context,
        ruleSet,
        list.rulesTests,
        `the rule tests for list "${pathName}"`
      );
    }
  }
}

/**
 * Show a rule change as a line diff, since rule text is usually many lines
 */
export function printRuleDiff(
  context: Context,
  from: string | null,
  to: string | null
): void {
  const { green, red, dim } = context.colours;
  // A file's trailing newline isn't a line of rules
  const lines = (text: string | null) =>
    text ? text.replace(/\n$/, '').split('\n') : [];
  const before = lines(from);
  const after = lines(to);

  if (before.length === 0 && after.length === 0) {
    context.log(`      ${dim('(no rules)')}`);
    return;
  }

  // The common start and end are usually most of the text
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start++;
  }

  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }

  if (start > 0) {
    context.log(
      dim(`      … ${start} unchanged ${start === 1 ? 'line' : 'lines'}`)
    );
  }

  for (const line of before.slice(start, before.length - end)) {
    context.log(red(`      - ${line}`));
  }
  for (const line of after.slice(start, after.length - end)) {
    context.log(green(`      + ${line}`));
  }

  if (end > 0) {
    context.log(
      dim(`      … ${end} unchanged ${end === 1 ? 'line' : 'lines'}`)
    );
  }
}
