import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { InMemoryAuthProvider } from "../src/auth/index.js";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import {
  EmbeddedSubtitleRelay,
  StremioAddonGateway,
  StremioApiClient,
  StremioService,
  type SaveStremioConnection,
  type StremioConnectionRepository
} from "../src/stremio/index.js";
import {
  MkvFormatError,
  extractMkvSubtitleVtt,
  listMkvSubtitleTracks,
  type ReadRange
} from "../src/stremio/mkv-subtitles.js";

// ---- Construtor mínimo de EBML --------------------------------------------------------------
function idBytes(id: number): Buffer {
  const bytes: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return Buffer.from(bytes);
}
function sizeBytes(size: number): Buffer {
  if (size < 0x7f) return Buffer.from([0x80 | size]);
  if (size < 0x3fff) return Buffer.from([0x40 | (size >> 8), size & 0xff]);
  const out = Buffer.alloc(4);
  out.writeUInt32BE(size);
  out[0] = 0x10 | out[0]!;
  return out;
}
function el(id: number, payload: Buffer | readonly Buffer[]): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
  return Buffer.concat([idBytes(id), sizeBytes(body.length), body]);
}
function uintEl(id: number, value: number, width = 0): Buffer {
  const bytes: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  while (bytes.length < Math.max(width, 1)) bytes.unshift(0);
  return el(id, Buffer.from(bytes));
}
const strEl = (id: number, value: string) => el(id, Buffer.from(value, "utf8"));

function blockPayload(track: number, relative: number, data: string): Buffer {
  const head = Buffer.alloc(3);
  head.writeInt16BE(relative, 0);
  return Buffer.concat([Buffer.from([0x80 | track]), head, Buffer.from(data, "utf8")]);
}

interface TestBlock {
  track: number;
  relative: number;
  text: string;
  duration?: number;
  group?: boolean;
  /** Sem CuePoint: simula faixa não indexada. */
  noCue?: boolean;
}

function trackEntry(number: number, type: number, codec: string, language: string, name?: string): Buffer {
  return el(0xae, [
    uintEl(0xd7, number), uintEl(0x83, type), strEl(0x86, codec), strEl(0x22b59c, language),
    ...(name ? [strEl(0x536e, name)] : [])
  ]);
}

// Tamanho com largura forçada (1 a 8 bytes): mkvmerge/outros muxers variam, e o caminho de uma
// leitura por cue precisa achar o bloco sem saber quanto o cabeçalho do Cluster ocupa.
function wideEl(id: number, payload: Buffer[], width: number): Buffer {
  const body = Buffer.concat(payload);
  const size = Buffer.alloc(width);
  size.writeUIntBE(body.length, width - 6 > 0 ? width - 6 : 0, Math.min(width, 6));
  size[0] = size[0]! | (0x80 >> (width - 1));
  return Buffer.concat([idBytes(id), size, body]);
}

function buildMkv(clusterSizeLen = 0): Buffer {
  const header = el(0x1a45dfa3, [strEl(0x4282, "matroska")]);
  const info = el(0x1549a966, [uintEl(0x2ad7b1, 1_000_000)]);
  const tracks = el(0x1654ae6b, [
    trackEntry(1, 1, "V_MPEG4/ISO/AVC", "und"),
    trackEntry(2, 0x11, "S_TEXT/ASS", "por", "Erai"),
    trackEntry(3, 0x11, "S_TEXT/UTF8", "eng"),
    trackEntry(4, 0x11, "S_TEXT/UTF8", "spa"),
    trackEntry(5, 0x11, "S_HDMV/PGS", "jpn")
  ]);
  const clusters: { timestamp: number; blocks: TestBlock[] }[] = [
    { timestamp: 1_000, blocks: [
      { track: 1, relative: 0, text: "VIDEO", noCue: true },
      { track: 2, relative: 500, text: "0,0,Default,,0,0,0,,{\\an8}Olá\\Nmundo & <i>", group: true, duration: 1_500 },
      { track: 2, relative: 100, text: "1,0,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}", duration: 500 },
      { track: 3, relative: 200, text: "Hello & <bye>", group: true, duration: 800 },
      { track: 4, relative: 300, text: "sem indice", noCue: true }
    ] },
    { timestamp: 5_000, blocks: [
      { track: 3, relative: 0, text: "Sem duracao" },
      { track: 3, relative: 1_000, text: "Segunda\n\nlinha", group: true, duration: 1_000 }
    ] }
  ];
  const clusterEls: { buffer: Buffer; cues: { track: number; time: number; relative: number; duration?: number }[] }[] = [];
  for (const cluster of clusters) {
    const parts: Buffer[] = [uintEl(0xe7, cluster.timestamp)];
    let offset = parts[0]!.length;
    const cues: { track: number; time: number; relative: number; duration?: number }[] = [];
    for (const block of cluster.blocks) {
      const payload = blockPayload(block.track, block.relative, block.text);
      const element = block.group
        ? el(0xa0, [el(0xa1, payload), ...(block.duration ? [uintEl(0x9b, block.duration)] : [])])
        : el(0xa3, payload);
      if (!block.noCue) cues.push({ track: block.track, time: cluster.timestamp + block.relative, relative: offset });
      parts.push(element);
      offset += element.length;
    }
    clusterEls.push({ buffer: clusterSizeLen ? wideEl(0x1f43b675, parts, clusterSizeLen) : el(0x1f43b675, parts), cues });
  }
  // SeekHead de tamanho fixo (posições em 4 bytes), preenchido depois.
  const seekHead = (positions: number[]) => el(0x114d9b74, [
    [0x1549a966, positions[0]!], [0x1654ae6b, positions[1]!], [0x1c53bb6b, positions[2]!]
  ].map(([id, pos]) => el(0x4dbb, [el(0x53ab, idBytes(id!)), uintEl(0x53ac, pos!, 4)])));
  const seekLength = seekHead([0, 0, 0]).length;
  const infoPos = seekLength;
  const tracksPos = infoPos + info.length;
  const cluster1Pos = tracksPos + tracks.length;
  const cluster2Pos = cluster1Pos + clusterEls[0]!.buffer.length;
  const cuesPos = cluster2Pos + clusterEls[1]!.buffer.length;
  const clusterPositions = [cluster1Pos, cluster2Pos];
  const cuePoints = clusterEls.flatMap((cluster, index) => cluster.cues.map((cue) => el(0xbb, [
    uintEl(0xb3, cue.time),
    el(0xb7, [
      uintEl(0xf7, cue.track), uintEl(0xf1, clusterPositions[index]!), uintEl(0xf0, cue.relative)
    ])
  ])));
  const cues = el(0x1c53bb6b, cuePoints);
  const segmentBody = Buffer.concat([
    seekHead([infoPos, tracksPos, cuesPos]), info, tracks, clusterEls[0]!.buffer, clusterEls[1]!.buffer, cues
  ]);
  const segmentSize = Buffer.alloc(8);
  segmentSize.writeUInt32BE(segmentBody.length, 4);
  segmentSize[0] = 0x01;
  return Buffer.concat([header, idBytes(0x18538067), segmentSize, segmentBody]);
}

const reader = (file: Buffer): ReadRange => async (start, length) => file.subarray(start, start + length);

test("lista só legendas de texto que têm cue points", async () => {
  const result = await listMkvSubtitleTracks(reader(buildMkv()));
  assert.deepEqual(result.tracks.map((track) => [track.number, track.codec, track.language, track.name]), [
    [2, "S_TEXT/ASS", "por", "Erai"],
    [3, "S_TEXT/UTF8", "eng", ""]
  ]);
  assert.equal(result.tracks[0]!.default, true);
  assert.equal(result.tracks[0]!.forced, false);
});

test("gera VTT da faixa ASS: texto limpo, desenho descartado", async () => {
  const vtt = await extractMkvSubtitleVtt(reader(buildMkv()), 2);
  assert.equal(vtt, "WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nOlá\nmundo &amp; &lt;i>\n");
});

test("gera VTT da faixa UTF8: ordem, duração, fallback de 4 s e escape", async () => {
  const vtt = await extractMkvSubtitleVtt(reader(buildMkv()), 3);
  assert.equal(vtt, [
    "WEBVTT", "",
    "00:00:01.200 --> 00:00:02.000\nHello &amp; &lt;bye>", "",
    // Sem duração: 4 s, mas cortado no início da próxima fala (6,000 s).
    "00:00:05.000 --> 00:00:06.000\nSem duracao", "",
    "00:00:06.000 --> 00:00:07.000\nSegunda\nlinha", ""
  ].join("\n"));
});

test("uma leitura por cue, com cabeçalho de Cluster de 1, 4 e 8 bytes de tamanho", async () => {
  for (const width of [1, 4, 8]) {
    const file = buildMkv(width);
    let calls = 0;
    const counting: ReadRange = async (start, length) => { calls += 1; return file.subarray(start, start + length); };
    await listMkvSubtitleTracks(counting);
    const base = calls;
    calls = 0;
    const vtt = await extractMkvSubtitleVtt(counting, 3);
    assert.equal(calls - base, 3, `largura ${width}`); // 3 cues na faixa 3, nenhuma leitura de Cluster
    assert.match(vtt, /00:00:01.200 --> 00:00:02.000\nHello &amp; &lt;bye>/);
    assert.match(vtt, /00:00:06.000 --> 00:00:07.000\nSegunda\nlinha/);
  }
});

test("faixa sem índice ou inexistente é erro controlado", async () => {
  await assert.rejects(extractMkvSubtitleVtt(reader(buildMkv()), 4), MkvFormatError);
  await assert.rejects(extractMkvSubtitleVtt(reader(buildMkv()), 99), MkvFormatError);
});

test("buffer truncado ou lixo vira MkvFormatError, nunca RangeError", async () => {
  const file = buildMkv();
  for (const cut of [0, 3, 40, 120, file.length - 200]) {
    await assert.rejects(listMkvSubtitleTracks(reader(file.subarray(0, cut))), MkvFormatError);
  }
  await assert.rejects(extractMkvSubtitleVtt(reader(file.subarray(0, file.length - 200)), 2), MkvFormatError);
  await assert.rejects(listMkvSubtitleTracks(reader(Buffer.alloc(500, 0xff))), MkvFormatError);
});

// ---- Rotas ----------------------------------------------------------------------------------
const webOrigin = "http://localhost:3000";

async function routeApp(relay: EmbeddedSubtitleRelay) {
  const repository: StremioConnectionRepository = {
    async save(_record: SaveStremioConnection) {},
    async find() { return null; },
    async status() { return { addonCount: 0, syncedAt: null }; },
    async delete() {}
  };
  const app = await buildApp({
    NODE_ENV: "test",
    CEBOLA_API_HOST: "127.0.0.1",
    CEBOLA_API_PORT: 3001,
    CEBOLA_WEB_ORIGIN: webOrigin,
    CEBOLA_SESSION_TTL_SECONDS: 3_600
  }, {
    authProvider: new InMemoryAuthProvider({
      users: [{ id: "user-a", email: "lucas@example.com", password: "correct-secret" }],
      tokenFactory: () => "embedded-session"
    }),
    householdRepository: new InMemoryHouseholdRepository(),
    householdService: new HouseholdService({ repository: new InMemoryHouseholdRepository() }),
    stremioService: new StremioService({ api: new StremioApiClient(), repository }),
    stremioGateway: new StremioAddonGateway(),
    embeddedSubtitles: relay
  });
  const login = await app.inject({
    method: "POST", url: "/v1/auth/login", headers: { origin: webOrigin },
    payload: { email: "lucas@example.com", password: "correct-secret" }
  });
  return { app, cookie: String(login.headers["set-cookie"]).split(";", 1)[0]! };
}

test("rotas de legenda embutida", async () => {
  let extractions = 0;
  const relay = new EmbeddedSubtitleRelay({
    listTracks: async () => [
      { number: 2, codec: "S_TEXT/ASS", language: "por", name: "Erai", forced: false, default: true },
      { number: 3, codec: "S_TEXT/UTF8", language: "eng", name: "", forced: false, default: false }
    ],
    extract: async () => { extractions += 1; return "WEBVTT\n\n"; }
  });
  const { app, cookie } = await routeApp(relay);
  const url = "/v1/stremio/subtitles/embedded";

  const anonymous = await app.inject({
    method: "POST", url, headers: { origin: webOrigin }, payload: { url: "https://1.1.1.1/a.mkv" }
  });
  assert.equal(anonymous.statusCode, 401);

  const insecure = await app.inject({
    method: "POST", url, headers: { origin: webOrigin, cookie }, payload: { url: "http://1.1.1.1/a.mkv" }
  });
  assert.equal(insecure.statusCode, 400);

  const listed = await app.inject({
    method: "POST", url, headers: { origin: webOrigin, cookie }, payload: { url: "https://1.1.1.1/a.mkv" }
  });
  assert.equal(listed.statusCode, 200);
  const body = JSON.parse(listed.body) as { subtitles: { id: string; label: string; language: string; addonName: string; url: string; details?: string }[] };
  assert.deepEqual(body.subtitles.map((item) => [item.id, item.label, item.language, item.addonName, item.details]),
    [["embedded:2", "Português", "por", "Arquivo", "Erai"], ["embedded:3", "Inglês", "eng", "Arquivo", undefined]]);
  assert.match(body.subtitles[0]!.url, /^\/v1\/stremio\/subtitles\/embedded\/[A-Za-z0-9_-]{43}\/2\/subtitle\.vtt$/);
  assert.equal(listed.body.includes("1.1.1.1"), false);

  const first = await app.inject({ method: "GET", url: body.subtitles[0]!.url });
  const second = await app.inject({ method: "GET", url: body.subtitles[0]!.url });
  assert.equal(first.statusCode, 200);
  assert.match(String(first.headers["content-type"]), /^text\/vtt; charset=utf-8/);
  assert.equal(first.headers["cache-control"], "private, max-age=3600");
  assert.equal(second.statusCode, 200);
  assert.equal(extractions, 1);

  const unknown = await app.inject({
    method: "GET", url: `/v1/stremio/subtitles/embedded/${"A".repeat(43)}/2/subtitle.vtt`
  });
  assert.equal(unknown.statusCode, 404);
  await app.close();
});

test("arquivo sem legendas indexadas responde lista vazia, não erro", async () => {
  const relay = new EmbeddedSubtitleRelay({ listTracks: async () => { throw new MkvFormatError("x"); } });
  const { app, cookie } = await routeApp(relay);
  const response = await app.inject({
    method: "POST", url: "/v1/stremio/subtitles/embedded", headers: { origin: webOrigin, cookie },
    payload: { url: "https://1.1.1.1/a.mkv" }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { subtitles: [] });
  await app.close();
});
