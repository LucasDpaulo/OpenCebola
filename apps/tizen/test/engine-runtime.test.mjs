import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
test('núcleo vendorizado lê os bytes do torrent em buffer circular sem iniciar aplicação upstream', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cebola-engine-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = join(dir, 'engine.cjs');
  const build = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../scripts/tizen-build-engine.cjs'), runtime], { encoding: 'utf8', timeout: 10000 });
  assert.equal(build.status, 0, build.stderr);
  const check = spawnSync(process.execPath, [join(import.meta.dirname, 'fixtures/engine-ring.cjs'), runtime], { encoding: 'utf8', timeout: 10000 });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /leitura de bytes aprovados/);
});
