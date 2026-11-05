'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const MEMORY_BYTES = 48 * 1024 * 1024;
const VIDEO = /\.(mkv|mp4|m4v|webm|avi|mov|ts|m2ts)$/i;

// Erro com texto escrito aqui, seguro para chegar à tela; erros de terceiros não levam a marca.
const motorError = message => Object.assign(new Error(message), { motor: true });

function createService(engine, options = {}) {
  const root = options.root || path.join(os.tmpdir(), 'cebola-tizen-streaming');
  const timeoutMs = options.timeoutMs || 30000;
  const deadAfterMs = options.deadAfterMs || 15000;
  const token = crypto.randomBytes(32).toString('hex');
  let active = null;
  const cancelledRequests = new Set();
  let tail = Promise.resolve();
  let port = 0;
  let watchdog;
  let lastContact = Date.now();
  fs.mkdirSync(root, { recursive: true });
  // Only this app's own directory; video pieces use a bounded memory ring.
  function clean() {
    for (const name of fs.readdirSync(root)) {
      if (/^[a-f0-9]{40}$/.test(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
  clean();
  const queue = task => { const p = tail.then(task, task); tail = p.catch(() => {}); return p; };
  async function stop(id) {
    const session = active;
    if (!session || (id && session.id !== id)) return;
    session.cancelled = true;
    if (session.abort) session.abort();
    for (const reader of session.readers) reader.destroy();
    await new Promise(resolve => engine.remove(session.hash, resolve));
    engine.removeAllListeners('engine-ready:' + session.hash);
    engine.removeAllListeners('engine-error:' + session.hash);
    if (active === session) active = null;
    clean();
  }
  function stats(id) {
    if (!active || active.id !== id) throw motorError('Sessão encerrada.');
    const s = engine.stats(active.hash) || {};
    return { phase: active.ready ? 'streaming' : 'buffering',
      downloadBytesPerSecond: s.downloadSpeed || 0, uploadBytesPerSecond: 0,
      peers: s.peers || 0, downloadedBytes: s.downloaded || 0 };
  }
  function trackerSources(trackers) {
    if (!Array.isArray(trackers)) return [];
    return [...new Set(trackers.filter(url => typeof url === 'string' && url.length <= 300 &&
      /^(udp|https?|wss?):\/\/[^\s]+$/i.test(url)))].slice(0, 40).map(url => 'tracker:' + url);
  }
  async function prepare(request) {
    if (!request || !/^[a-f0-9]{40}$/i.test(request.infoHash) ||
        typeof request.requestId !== 'string' || request.requestId.length > 128 ||
        (request.fileIdx !== null && (!Number.isInteger(request.fileIdx) || request.fileIdx < 0))) {
      throw motorError('Torrent inválido.');
    }
    if (cancelledRequests.delete(request.requestId)) throw new Error("Preparação cancelada.");
    await stop();
    const hash = request.infoHash.toLowerCase();
    const session = { id: crypto.randomBytes(24).toString('hex'), requestId: request.requestId,
      hash, readers: new Set(), cancelled: false, ready: false };
    active = session;
    try {
      const instance = await new Promise((resolve, reject) => {
        const semResposta = () => { clearTimers(); reject(motorError('Torrent sem resposta. Tente outra fonte.')); };
        const timer = setTimeout(semResposta, timeoutMs);
        // Fonte morta não conecta nenhum peer; esperar o prazo inteiro só atrasava a troca de fonte.
        // Com algum peer conectado, os metadados podem estar vindo: segue até o prazo normal.
        const deadCheck = setTimeout(() => { if (!((engine.stats(hash) || {}).peers > 0)) semResposta(); }, deadAfterMs);
        function clearTimers() { clearTimeout(timer); clearTimeout(deadCheck); }
        const fail = () => { clearTimers(); reject(motorError('Preparação cancelada.')); };
        session.abort = fail;
        const onError = () => { clearTimers(); reject(motorError('Não foi possível abrir o torrent.')); };
        engine.once('engine-error:' + hash, onError);
        engine.create(hash, {
          path: path.join(root, hash), torrent: { infoHash: hash },
          // Só DHT deixava a TV sem peers em 30 s (testado na QN55QEF1A, 25/10): os trackers que o
          // add-on anuncia entram como fontes. Só URLs de anúncio validadas; nenhum caminho local.
          peerSearch: { min: 10, max: 35, sources: ['dht:' + hash, ...trackerSources(request.trackers)] },
          connections: 25, uploads: 0, handshakeTimeout: 10000, timeout: 4000,
          buffer: 16 * 1024 * 1024, circularBuffer: { type: 'memory', size: MEMORY_BYTES },
          swarmCap: { minPeers: 3, maxBuffer: 0.75 }, growler: { flood: 0, pulse: 3 * 1024 * 1024 }
        }, (error, value) => {
          clearTimers();
          engine.removeListener('engine-error:' + hash, onError);
          if (error) reject(motorError('Torrent indisponível.'));
          else resolve(value);
        });
      });
      if (session.cancelled) throw motorError('Preparação cancelada.');
      // Keep actual verification enabled, and refuse pieces larger than the memory budget.
      if (instance.torrent.pieceLength > MEMORY_BYTES / 2) throw motorError('Arquivo exige memória demais para a TV.');
      let idx = request.fileIdx;
      const files = instance.files;
      if (idx === null && typeof request.filename === 'string') idx = files.findIndex(f => f.name === request.filename);
      if (idx === null || idx < 0) {
        idx = files.reduce((best, file, i) => VIDEO.test(file.name) &&
          (best < 0 || file.length > files[best].length) ? i : best, -1);
      }
      const file = files[idx];
      if (!file || !VIDEO.test(file.name)) throw motorError('O torrent não contém o vídeo solicitado.');
      session.file = file;
      session.fileIdx = idx;
      // Read a real initial block before exposing a URL to AVPlay. Bounded ring keeps it warm.
      await new Promise((resolve, reject) => {
        const stream = file.createReadStream({ start: 0, end: Math.min(file.length, 8 * 1024 * 1024) - 1 });
        session.readers.add(stream);
        const timer = setTimeout(() => { stream.destroy(); reject(motorError('Torrent lento demais para iniciar.')); }, timeoutMs);
        session.abort = () => { stream.destroy(); clearTimeout(timer); reject(motorError('Preparação cancelada.')); };
        stream.on('error', () => { clearTimeout(timer); reject(motorError('Falha ao ler o torrent.')); });
        stream.on('end', () => { clearTimeout(timer); session.readers.delete(stream); resolve(); });
        stream.resume();
      });
      if (session.cancelled) throw motorError('Preparação cancelada.');
      session.abort = null;
      session.ready = true;
      return { id: session.id, url: 'http://127.0.0.1:' + port + '/video/' + session.id,
        fileIdx: idx, filename: file.name, size: file.length };
    } catch (error) { await stop(session.id); throw error; }
  }
  const commands = {
    capabilities: async () => ({ available: true, backend: 'tizen-enginefs' }),
    prepare: args => queue(() => prepare(args)),
    cancel: args => {
      cancelledRequests.add(args.requestId);
      if (cancelledRequests.size > 64) cancelledRequests.delete(cancelledRequests.values().next().value);
      if (active && active.requestId === args.requestId) { active.cancelled = true; if (active.abort) active.abort(); }
      return queue(() => active && active.requestId === args.requestId ? stop(active.id) : undefined);
    },
    stop: args => { if (active && active.id === args.id && active.abort) active.abort(); return queue(() => stop(args.id)); },
    stats: async args => stats(args.id),
    cacheInfo: async () => {
      function bytes(directory) {
        return fs.readdirSync(directory).reduce((sum, name) => {
          const file = path.join(directory, name), stat = fs.lstatSync(file);
          return sum + (stat.isDirectory() ? bytes(file) : stat.isFile() ? stat.size : 0);
        }, 0);
      }
      const usedBytes = bytes(root);
      return { usedBytes, capacityBytes: 64 * 1024 * 1024, protectedBytes: active ? usedBytes : 0 };
    },
    clearCache: () => queue(async () => { if (!active) clean(); }),
    shutdown: () => { if (active && active.abort) active.abort(); return queue(() => stop()); }
  };
  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && origin !== 'file://') return json(res, 403, {});
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cebola-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.writeHead(204); return res.end();
    }
    if (req.url === '/hello' && req.method === 'GET') return json(res, 200, { token, backend: 'cebola-tizen-enginefs-v1' });
    const session = active;
    if (session && session.ready && req.url === '/video/' + session.id && ['GET', 'HEAD'].includes(req.method)) {
      lastContact = Date.now();
      const length = session.file.length;
      let start = 0, end = length - 1;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': 'bytes */' + length }); return res.end(); }
        if (match[1]) {
          start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
        } else {
          start = Math.max(0, length - Number(match[2]));
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= length) { res.writeHead(416, { 'Content-Range': 'bytes */' + length }); return res.end(); }
        res.statusCode = 206;
        res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + length);
      }
      res.setHeader('Content-Length', end - start + 1);
      res.setHeader('Accept-Ranges', 'bytes');
      const mime = { '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime' };
      res.setHeader('Content-Type', mime[path.extname(session.file.name).toLowerCase()] || 'video/mp4');
      if (req.method === 'HEAD') return res.end();
      const stream = session.file.createReadStream({ start, end });
      session.readers.add(stream);
      res.on('close', () => { stream.destroy(); session.readers.delete(stream); });
      stream.on('error', () => res.destroy());
      return stream.pipe(res);
    }
    if (req.method !== 'POST' || req.headers['x-cebola-token'] !== token) return json(res, 403, {});
    lastContact = Date.now();
    const command = req.url.slice(1);
    if (!Object.prototype.hasOwnProperty.call(commands, command)) return json(res, 404, {});
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let args;
      try { args = JSON.parse(body || '{}'); } catch (_) { return json(res, 400, {}); }
      Promise.resolve().then(() => commands[command](args)).then(
        value => json(res, 200, value || {}),
        // Só os motivos do próprio motor (prazo, memória, arquivo) saem; qualquer outro erro fica genérico.
        error => json(res, 400, { error: error && error.motor ? error.message : 'Não foi possível preparar esta fonte na TV.' })
      );
    });
  });
  return {
    commands,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port === undefined ? 2713 : options.port, '127.0.0.1', () => {
        port = server.address().port;
        // A crashed UI must not leave a swarm alive. The shell sends a heartbeat.
        watchdog = setInterval(() => { if (Date.now() - lastContact > 45000) void commands.shutdown();
          else void commands.cacheInfo().then(info => { if (info.usedBytes > info.capacityBytes) void commands.shutdown(); }); }, 5000);
        resolve(port);
      });
    }),
    close: async () => { clearInterval(watchdog); await commands.shutdown(); await new Promise(resolve => server.close(resolve)); }
  };
}
module.exports = { createService, MEMORY_BYTES };
