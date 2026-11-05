// Export only the vendored EngineFS core and torrent implementation. Never run the
// upstream HTTP application (accounts, proxies, filesystem endpoints, transcoders).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sourcePath = path.resolve(__dirname, '../third_party/nuvio-tvsmart/services/tizen/runtime/media-http.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const digest = crypto.createHash('sha256').update(source).digest('hex');
if (digest !== '07a83981c856a5347758e116961d1d5d18715267a3afd6b115201b8f53e04c70') throw new Error('Runtime EngineFS mudou: revisar os módulos exportados antes de empacotar');
const entry = 'module.exports = __webpack_require__(__webpack_require__.s = 685);';
if (source.split(entry).length !== 2) throw new Error('Layout EngineFS desconhecido');
const output = source.replace(entry, 'var core = __webpack_require__(260); core.engine = __webpack_require__(1123); module.exports = core;');
const destination = process.argv[2];
if (!destination) throw new Error('Informe o destino do runtime gerado');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, output);
console.log('EngineFS core: ' + crypto.createHash('sha256').update(source).digest('hex'));
