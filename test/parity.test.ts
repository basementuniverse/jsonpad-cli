/**
 * The four commands ported from @basementuniverse/jsonpad-sdk's bin must
 * behave exactly as they did there: the same output, exit codes, API requests
 * and files. The golden files were recorded from that bin, which was removed in
 * SDK 2.0.0, so they can't be recorded again: change them only by hand
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import {
  CLI_BIN,
  goldenPath,
  runScenario,
  type Result,
} from './parity/harness.ts';
import { ALIASES, scenarios } from './parity/scenarios.ts';

function readGolden(path: string): Result {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

describe('parity with the legacy jsonpad command', { concurrency: 8 }, () => {
  for (const scenario of scenarios) {
    const golden = readGolden(goldenPath(scenario));

    test(scenario.name, async () => {
      const result = await runScenario(CLI_BIN, scenario);

      if (scenario.compare === 'exitCode') {
        assert.equal(result.exitCode, golden.exitCode);
      } else {
        assert.deepEqual(result, golden);
      }
    });

    const alias = ALIASES[scenario.args[0]];
    if (alias && scenario.compare !== 'exitCode') {
      const args = [...alias, ...scenario.args.slice(1)];

      test(`${scenario.name} (as jsonpad ${alias.join(' ')})`, async () => {
        assert.deepEqual(await runScenario(CLI_BIN, scenario, args), golden);
      });
    }
  }
});

test('every scenario has a golden file, and there are no stale ones', () => {
  const expected = scenarios.map(scenario => goldenPath(scenario)).sort();
  const dir = goldenPath({ name: '', args: [] }).replace(/\/\.json$/, '');
  const actual = fs
    .readdirSync(dir)
    .map(file => `${dir}/${file}`)
    .sort();

  assert.deepEqual(actual, expected);
});
