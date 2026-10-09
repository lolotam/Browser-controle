import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { crc32, overlongDescriptions, packageFiles, storeManifest, zip } from '../scripts/package.mjs';

test('the store package holds only what the extension runs', () => {
  const files = packageFiles();
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('src/background/service-worker.js'));
  assert.ok(files.includes('_locales/ar/messages.json'));
  assert.ok(files.includes('icons/icon-128.png'));
  assert.ok(!files.includes('icons/logo-source.png'));
  assert.deepEqual(files.filter((f) => /^(test|docs|scripts|node_modules|\.git)\//.test(f) || f === 'package.json'), []);
});

test('the uploaded manifest drops the development key', () => {
  const out = storeManifest({ manifest_version: 3, key: 'MIIB…', name: 'x' });
  assert.equal('key' in out, false);
  assert.equal(out.name, 'x');
});

test('every locale description fits the store limit', () => {
  assert.deepEqual(overlongDescriptions(), []);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('zip writes entries that inflate back to their bytes', () => {
  const data = Buffer.from('hello hello hello');
  const archive = zip([{ name: 'a/b.txt', data }]);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const nameLen = archive.readUInt16LE(26);
  const size = archive.readUInt32LE(18);
  const body = archive.subarray(30 + nameLen, 30 + nameLen + size);
  assert.equal(zlib.inflateRawSync(body).toString(), 'hello hello hello');
  assert.equal(archive.subarray(30, 30 + nameLen).toString(), 'a/b.txt');
});
