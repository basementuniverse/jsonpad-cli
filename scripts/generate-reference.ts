/**
 * Write REFERENCE.md from the command definitions
 *
 * Usage: node scripts/generate-reference.ts [--check]
 *
 * With --check, nothing is written, and the exit code is 1 if REFERENCE.md is
 * out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { createContext } from '../src/context.ts';
import { generateReference } from '../src/reference.ts';

const file = path.resolve(import.meta.dirname, '../REFERENCE.md');
const reference = generateReference(
  createContext({ env: {}, stdout: { write: () => true } })
);

if (process.argv.includes('--check')) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  if (current !== reference) {
    console.error('REFERENCE.md is out of date. Run npm run reference');
    process.exit(1);
  }
} else {
  fs.writeFileSync(file, reference);
  console.log('Wrote REFERENCE.md');
}
