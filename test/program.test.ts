import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Command } from 'commander';
import { createProgram, run, version } from '../src/program.ts';
import { createTestContext } from './helpers.ts';

function findCommand(program: Command, names: string[]): Command {
  return names.reduce((command, name) => {
    const found = command.commands.find(child => child.name() === name);
    assert.ok(found, `no command ${names.join(' ')}`);
    return found;
  }, program);
}

test('no arguments prints help to stdout and exits 0', async () => {
  const context = createTestContext();

  assert.equal(await run([], context), 0);
  assert.match(context.output.stdout, /^Usage: jsonpad <command> \[options\]/);
  assert.match(context.output.stdout, /Exit codes:/);
  assert.equal(context.output.stderr, '');
});

test('--version prints the package version', async () => {
  const context = createTestContext();

  assert.equal(await run(['--version'], context), 0);
  assert.equal(context.output.stdout, `${version}\n`);
});

test('schema aliases have the same arguments and options', () => {
  const program = createProgram(createTestContext());
  const signature = (command: Command) => ({
    description: command.description(),
    arguments: command.registeredArguments.map(argument => [
      argument.name(),
      argument.required,
      argument.variadic,
      argument.defaultValue,
    ]),
    options: command.options.map(option => [option.flags, option.description]),
  });

  for (const [flat, alias] of [
    ['sync-schema', 'sync'],
    ['export-schema', 'export'],
    ['move-lists', 'move'],
  ]) {
    assert.deepEqual(
      signature(findCommand(program, ['schema', alias])),
      signature(findCommand(program, [flat]))
    );
  }
});

test('errors are coloured red only on a TTY without NO_COLOR', async () => {
  const plain = createTestContext({ isTTY: true, env: { NO_COLOR: '' } });
  assert.equal(await run(['move-lists'], plain), 1);
  assert.doesNotMatch(plain.output.stderr, /\x1b\[/);

  const coloured = createTestContext({ isTTY: true });
  assert.equal(await run(['move-lists'], coloured), 1);
  assert.match(coloured.output.stderr, /^\x1b\[31mPass either --to/);
});

test('an unexpected error prints its stack and exits 1', async () => {
  const context = createTestContext();
  const program = createProgram(context);

  // Simulate a bug in a command
  findCommand(program, ['rebuild-index']).action(() => {
    throw new TypeError('boom');
  });

  assert.equal(await run(['rebuild-index', 'a', 'b'], context, program), 1);
  assert.match(context.output.stderr, /^Error: TypeError: boom\n\s+at /);
});
