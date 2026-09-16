import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { generateReference } from '../src/reference.ts';
import { createTestContext } from './helpers.ts';

test('REFERENCE.md is up to date (run npm run reference)', () => {
  const file = path.resolve(import.meta.dirname, '../REFERENCE.md');

  assert.equal(
    fs.readFileSync(file, 'utf8'),
    generateReference(createTestContext())
  );
});
