'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLang, parseModsToml, resolveAssetBucket, nearestVersion } = require('../src/services/itemRegistry');

test('parseLang keeps exact item/block keys, skips sub-entries and non-strings', () => {
  const buf = Buffer.from(
    JSON.stringify({
      'item.minecraft.diamond_sword': 'Diamond Sword',
      'block.minecraft.stone': 'Stone',
      'item.minecraft.diamond_sword.tooltip': 'A sharp sword', // 4-segment, skipped
      'itemGroup.combat': 'Combat', // not item./block., skipped
      'item.minecraft.empty': '',
      'item.minecraft.weird': 5,
    })
  );
  const out = parseLang(buf);
  assert.deepEqual(out.map((e) => e.id).sort(), ['minecraft:diamond_sword', 'minecraft:stone']);
  assert.equal(out.find((e) => e.id === 'minecraft:diamond_sword').kind, 'item');
  assert.equal(out.find((e) => e.id === 'minecraft:stone').kind, 'block');
});

test('parseLang tolerates malformed JSON', () => {
  assert.deepEqual(parseLang(Buffer.from('not json')), []);
});

test('parseModsToml reads modId/displayName pairs', () => {
  const toml = `
[[mods]]
modId = "examplemod"
displayName = "Example Mod"
version = "1.0"

[[mods]]
modId = "other"
`;
  const names = parseModsToml(toml);
  assert.equal(names.get('examplemod'), 'Example Mod');
  assert.equal(names.get('other'), null);
});

test('resolveAssetBucket maps a requested MC version to the nearest texture bucket at or before it', () => {
  assert.equal(resolveAssetBucket('1.21.4'), '1.21.4'); // exact
  assert.equal(resolveAssetBucket('1.21.9'), '1.21.8'); // newer than anything known -> newest bucket
  assert.equal(resolveAssetBucket('1.20.4'), '1.20.2'); // between buckets -> nearest below
  assert.equal(resolveAssetBucket('1.7.10'), '1.8.8'); // older than everything -> oldest bucket
  assert.equal(resolveAssetBucket(''), '1.21.8'); // unparsable -> newest
  assert.equal(resolveAssetBucket('26.2'), '1.21.8'); // fictional/future scheme -> newest known
});

test('nearestVersion picks exact match, else the newest available at or below the request, else the oldest', () => {
  const available = ['1.20.1', '1.20.4', '1.21.1', '1.21.4'];
  assert.equal(nearestVersion('1.21.1', available), '1.21.1');
  assert.equal(nearestVersion('1.21.3', available), '1.21.1'); // between 1.21.1 and 1.21.4
  assert.equal(nearestVersion('1.22.0', available), '1.21.4'); // newer than everything
  assert.equal(nearestVersion('1.0.0', available), '1.20.1'); // older than everything -> oldest available
  assert.equal(nearestVersion('', available), '1.21.4'); // unparsable request -> newest
  assert.equal(nearestVersion('1.21.1', []), null);
});
