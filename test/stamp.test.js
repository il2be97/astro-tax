import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stamped } from '../scripts/stamp.mjs';

test('index.html cache stamps match current files (run `npm run stamp`)', () => {
  assert.equal(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), stamped());
});
