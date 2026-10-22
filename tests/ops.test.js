// Usage counting and the migration list.
const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../server/ops');

test('only known sections are counted', () => {
  assert.equal(ops.countUse('ul.lux', 'creatives'), true);
  assert.equal(ops.countUse('ul.lux', '<script>'), false);
  assert.equal(ops.countUse('', 'creatives'), false);
});

test('every migration file is found, numbered and unique by name', () => {
  const files = ops.migrationFiles();
  assert.ok(files.length >= 30);
  assert.ok(files.every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)));
  assert.ok(files.includes('037_ops_tables.sql'));
  assert.equal(new Set(files).size, files.length);
});
