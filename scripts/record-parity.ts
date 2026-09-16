/**
 * Record what the legacy jsonpad command (the bin in
 * @basementuniverse/jsonpad-sdk) does for each parity scenario, as the golden
 * files the parity tests compare this CLI against
 *
 * Usage: node scripts/record-parity.ts [path to the legacy bin/jsonpad.js]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  goldenPath,
  GOLDEN_DIR,
  ROOT,
  runScenario,
} from '../test/parity/harness.ts';
import { scenarios } from '../test/parity/scenarios.ts';

const legacyBin = path.resolve(
  process.argv[2] ?? path.join(ROOT, '../jsonpad-sdk-js/bin/jsonpad.js')
);

if (!fs.existsSync(legacyBin)) {
  console.error(`Can't find the legacy command at ${legacyBin}`);
  process.exit(1);
}

fs.rmSync(GOLDEN_DIR, { recursive: true, force: true });
fs.mkdirSync(GOLDEN_DIR, { recursive: true });

for (const scenario of scenarios) {
  const result = await runScenario(legacyBin, scenario);
  fs.writeFileSync(
    goldenPath(scenario),
    `${JSON.stringify(result, null, 2)}\n`
  );
  console.log(`${scenario.name}: exit ${result.exitCode}`);
}
