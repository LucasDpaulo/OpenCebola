import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createService, MEMORY_BYTES } = createRequire(import.meta.url)('../services/streaming-core.cjs');
const hash = 'a'.repeat(40);
function setup(t, { stalled = false, peers, timeoutMs = 20, deadAfterMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cebola-engine-test-'));
  const engine = new EventEmitter();
  engine.create = (id, options, cb) => {
    engine.options = options; engine.current = id;
    mkdirSync(join(root, id), { recursive: true }); writeFileSync(join(root, id, 'cache'), 'metadata');
    if (!stalled) cb(null, { torrent: { pieceLength: 16384 }, files: [{ name: 'episode.mkv', length: 100,
      createReadStream: ({ start, end }) => Readable.from([Buffer.alloc(end - start + 1, 65)]) }] });
  };
  engine.remove = (id, cb) => { engine.removed = id; engine.current = null; cb(); };
  engine.stats = () => ({ downloaded: 100, peers });
  const service = createService(engine, { root, timeoutMs, deadAfterMs, port: 0 });
  t.after(async () => { await service.commands.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return { root, engine, service };
}
test('prepara vídeo com memória limitada; troca e encerra limpam metadados', async t => {
  const { service, root, engine } = setup(t);
  const first = await service.commands.prepare({ infoHash: hash, fileIdx: null, requestId: '1' });
  assert.equal(first.filename, 'episode.mkv');
  assert.equal(engine.options.circularBuffer.size, MEMORY_BYTES);
  assert.equal(engine.options.uploads, 0);
  const next = await service.commands.prepare({ infoHash: 'b'.repeat(40), fileIdx: 0, requestId: '2' });
  assert.equal(engine.removed, hash);
  assert.deepEqual(readdirSync(root), ['b'.repeat(40)]);
  await service.commands.stop({ id: first.id });
  assert.equal(engine.current, 'b'.repeat(40));
  await service.commands.stop({ id: next.id });
  assert.deepEqual(readdirSync(root), []);
});
test('timeout de metadados encerra motor e remove resíduos', async t => {
  const { service, root, engine } = setup(t, { stalled: true });
  await assert.rejects(service.commands.prepare({ infoHash: hash, fileIdx: 0, requestId: 'slow' }), /sem resposta/);
  assert.equal(engine.removed, hash);
  assert.deepEqual(readdirSync(root), []);
});
test('torrent sem nenhum peer desiste antes do prazo; com peer espera o prazo', async t => {
  const morto = setup(t, { stalled: true, peers: 0, timeoutMs: 5000, deadAfterMs: 20 });
  const inicio = Date.now();
  await assert.rejects(morto.service.commands.prepare({ infoHash: hash, fileIdx: 0, requestId: 'morto' }), /sem resposta/);
  assert.ok(Date.now() - inicio < 1000);
  const vivo = setup(t, { stalled: true, peers: 2, timeoutMs: 150, deadAfterMs: 20 });
  const comeco = Date.now();
  await assert.rejects(vivo.service.commands.prepare({ infoHash: hash, fileIdx: 0, requestId: 'vivo' }), /sem resposta/);
  assert.ok(Date.now() - comeco >= 140);
});
test('cancelamento interrompe preparo; cancelamento antigo não para sessão nova', async t => {
  const { service, root } = setup(t, { stalled: true });
  const pending = service.commands.prepare({ infoHash: hash, fileIdx: 0, requestId: 'cancel' });
  await new Promise(resolve => setImmediate(resolve));
  const stopped = service.commands.cancel({ requestId: 'cancel' });
  await assert.rejects(pending, /cancelada/);
  await stopped;
  assert.deepEqual(readdirSync(root), []);
});
test('rejeita índice inexistente e hash com caminho', async t => {
  const { service } = setup(t);
  await assert.rejects(service.commands.prepare({ infoHash: '../cache', fileIdx: 0, requestId: 'x' }));
  await assert.rejects(service.commands.prepare({ infoHash: hash, fileIdx: 3, requestId: 'x' }), /vídeo solicitado/);
});
test('cancelamento que chega antes do prepare impede abertura tardia', async t => {
  const { service, engine } = setup(t);
  await service.commands.cancel({ requestId: 'early' });
  await assert.rejects(service.commands.prepare({ infoHash: hash, fileIdx: 0, requestId: 'early' }), /cancelada/);
  assert.equal(engine.current, undefined);
});
test('HTTP exige token; vídeo suporta range e encerra após stop', async t => {
  const { service } = setup(t);
  const port = await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/hello', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(base + '/prepare', { method: 'POST', body: '{}' })).status, 403);
  const hello = await (await fetch(base + '/hello')).json();
  const response = await fetch(base + '/prepare', { method: 'POST',
    headers: { 'X-Cebola-Token': hello.token }, body: JSON.stringify({ infoHash: hash, fileIdx: 0, requestId: 'http' }) });
  assert.equal(response.status, 200);
  const session = await response.json();
  const video = await fetch(session.url, { headers: { Range: 'bytes=5-9' } });
  assert.equal(video.status, 206); assert.equal(video.headers.get('Content-Range'), 'bytes 5-9/100');
  assert.equal((await video.arrayBuffer()).byteLength, 5);
  const suffix = await fetch(session.url, { headers: { Range: 'bytes=-10' } });
  assert.equal(suffix.headers.get('Content-Range'), 'bytes 90-99/100');
  assert.equal((await suffix.arrayBuffer()).byteLength, 10);
  assert.equal((await fetch(session.url, { headers: { Range: 'bytes=200-' } })).status, 416);
  await service.commands.stop({ id: session.id });
  assert.notEqual((await fetch(session.url)).status, 200);
});
test('trackers do add-on viram fontes de peers; valores inválidos ficam de fora', async t => {
  const { service, engine } = setup(t);
  await service.commands.prepare({ infoHash: hash, fileIdx: null, requestId: '1', trackers: [
    'udp://tracker.opentrackr.org:1337/announce', 'udp://tracker.opentrackr.org:1337/announce',
    'https://tracker.example/announce', 'file:///etc/passwd', '../../x', 42
  ] });
  assert.deepEqual(engine.options.peerSearch.sources, ['dht:' + hash,
    'tracker:udp://tracker.opentrackr.org:1337/announce', 'tracker:https://tracker.example/announce']);
});
test('HTTP repassa o motivo do motor quando o preparo falha', async t => {
  const { service } = setup(t, { stalled: true });
  const port = await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${port}`;
  const hello = await (await fetch(base + '/hello')).json();
  const response = await fetch(base + '/prepare', { method: 'POST',
    headers: { 'X-Cebola-Token': hello.token }, body: JSON.stringify({ infoHash: hash, fileIdx: 0, requestId: 'lento' }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Torrent sem resposta. Tente outra fonte.' });
});
