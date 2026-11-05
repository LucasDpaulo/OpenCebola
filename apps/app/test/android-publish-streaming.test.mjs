import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '../../../scripts/android-publish-streaming.sh');
const host = 'cebola.example';

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'cebola-android-publish-'));
  const downloads = path.join(root, '.release/downloads');
  mkdirSync(downloads, { recursive: true });
  const manifests = [];
  for (const [abi, suffix] of [['arm64-v8a', ''], ['armeabi-v7a', '-arm32']]) {
    const payload = path.join(root, abi);
    mkdirSync(path.join(payload, 'lib', abi), { recursive: true });
    writeFileSync(path.join(payload, 'lib', abi, 'libnuvio_engine.so'), 'fixture');
    const file = `cebola-release${suffix}.apk`;
    execFileSync('zip', ['-qr', path.join(downloads, file), 'lib'], { cwd: payload });
    const sha256 = createHash('sha256').update(readFileSync(path.join(downloads, file))).digest('hex');
    writeFileSync(path.join(downloads, `${file}.sha256`), `${sha256}  ${file}\n`);
    const manifest = path.join(downloads, `cebola-android${suffix}-latest.json`);
    writeFileSync(manifest, JSON.stringify({ versionCode: 200, versionName: '1.0.200',
      url: `https://${host}/downloads/${file}`, sha256 }));
    manifests.push(manifest);
  }
  const execute = (mode = 'verify', env = {}) => spawnSync('bash', [script, mode], {
    cwd: root, encoding: 'utf8', env: { ...process.env, DEPLOY_HOST: host, ...env }
  });
  const change = (index, values) => writeFileSync(manifests[index],
    JSON.stringify({ ...JSON.parse(readFileSync(manifests[index])), ...values }));
  try { run({ root, downloads, execute, change }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('aceita os dois APKs e manifestos consistentes', () => fixture(({ execute }) => {
  const result = execute();
  assert.equal(result.status, 0, result.stderr);
}));

test('recusa APK adulterado', () => fixture(({ downloads, execute }) => {
  writeFileSync(path.join(downloads, 'cebola-release-arm32.apk'), 'corrompido');
  assert.notEqual(execute().status, 0);
}));

test('recusa URL de outro host e versões divergentes', () => {
  fixture(({ change, execute }) => {
    change(0, { url: 'https://outro.example/app.apk' });
    assert.notEqual(execute().status, 0);
  });
  fixture(({ change, execute }) => {
    change(1, { versionCode: 201, versionName: '1.0.201' });
    assert.notEqual(execute().status, 0);
  });
});

test('recusa hash incorreto no manifesto e versão fracionada', () => {
  fixture(({ change, execute }) => {
    change(0, { sha256: '0'.repeat(64) });
    assert.notEqual(execute().status, 0);
  });
  fixture(({ change, execute }) => {
    change(0, { versionCode: 200.5, versionName: '1.0.200.5' });
    assert.notEqual(execute().status, 0);
  });
});

test('impede republicar uma versão antiga antes de acessar SSH', () => fixture(({ root, execute }) => {
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf \'{"versionCode":201}\\n\'\n', { mode: 0o755 });
  const result = execute('deploy', { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pacote antigo/);
}));

test('falha de consulta da versão publicada aborta antes do SSH', () => fixture(({ root, execute }) => {
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 });
  const result = execute('deploy', { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /DEPLOY_KEY/);
}));
