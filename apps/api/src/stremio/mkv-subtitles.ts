import { assTextToVtt } from "./subtitle-format.js";
import { repairDoubleEncodedUtf8 } from "./subtitle-encoding.js";

// Leitor mínimo de Matroska só para legendas de texto embutidas. Na TV Samsung o player do
// navegador toca o MKV mas não expõe as faixas de legenda do arquivo. Em vez de baixar 1,5 GB, usa
// o índice (Cues) que o mkvmerge grava com um CuePoint por bloco de legenda: lê o cabeçalho, as
// Cues e cada bloco com Range pequeno. Tudo aqui é puro (recebe `readRange`) para ser testável sem
// rede; o acesso remoto seguro vive em mkv-remote.ts.

export type ReadRange = (start: number, length: number) => Promise<Buffer>;

export interface MkvSubtitleTrack {
  readonly number: number;
  readonly codec: string;
  readonly language: string;
  readonly name: string;
  readonly forced: boolean;
  readonly default: boolean;
}

/** Arquivo corrompido, truncado ou fora do que este leitor entende — erro controlado. */
export class MkvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MkvFormatError";
  }
}

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  language: 0x22b59c,
  languageBcp47: 0x22b59d,
  name: 0x536e,
  flagDefault: 0x88,
  flagForced: 0x55aa,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
  cueRelativePosition: 0xf0,
  cueDuration: 0xb2,
  cluster: 0x1f43b675,
  clusterTimestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b
} as const;

const SUBTITLE_TRACK_TYPE = 0x11;
const SUPPORTED_CODECS = new Set(["S_TEXT/UTF8", "S_TEXT/ASS", "S_TEXT/SSA", "S_TEXT/WEBVTT"]);

const HEAD_BYTES = 65_536;
const MAX_CUES_BYTES = 4 * 1_024 * 1_024;
const MAX_TRACKS_BYTES = 1_024 * 1_024;
const MAX_INFO_BYTES = 64 * 1_024;
const MAX_CUE_POINTS = 50_000;
const MAX_BLOCK_BYTES = 65_536;
// Um bloco de legenda costuma ter menos de 1 KB: uma leitura de 2 KB pega cabeçalho e dados de uma
// vez, e só os raros blocos maiores pedem uma segunda leitura com o tamanho exato.
const BLOCK_PEEK_BYTES = 2_048;
// O servidor do Real-Debrid derruba conexões (ECONNRESET) com 32 leituras simultâneas no mesmo
// arquivo (medido em 03/10/2026); 12 ainda dividem a latência de ~0,9 s por leitura.
const READ_CONCURRENCY = 12;
const FALLBACK_CUE_MS = 4_000;

interface ElementHeader {
  readonly id: number;
  /** `null` = tamanho desconhecido (todos os bits 1). */
  readonly size: number | null;
  readonly dataStart: number;
}

// ID mantém o marcador de tamanho (lido cru); até 4 bytes pela especificação.
function readId(buffer: Buffer, position: number): { id: number; length: number } {
  const first = buffer[position];
  if (first === undefined || first === 0) throw new MkvFormatError("ID EBML inválido");
  const length = Math.clz32(first) - 24 + 1;
  if (length > 4 || position + length > buffer.length) throw new MkvFormatError("ID EBML truncado");
  let id = 0;
  for (let index = 0; index < length; index += 1) id = id * 256 + buffer[position + index]!;
  return { id, length };
}

// Tamanho tira o marcador. Acima de 2^53 não cabe em Number com segurança: tratado como corrompido.
function readSize(buffer: Buffer, position: number): { size: number | null; length: number } {
  const first = buffer[position];
  if (first === undefined || first === 0) throw new MkvFormatError("tamanho EBML inválido");
  const length = Math.clz32(first) - 24 + 1;
  if (position + length > buffer.length) throw new MkvFormatError("tamanho EBML truncado");
  let value = first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let index = 1; index < length; index += 1) {
    const byte = buffer[position + index]!;
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }
  if (allOnes) return { size: null, length };
  if (!Number.isSafeInteger(value)) throw new MkvFormatError("tamanho EBML grande demais");
  return { size: value, length };
}

function readHeader(buffer: Buffer, position: number): ElementHeader {
  const { id, length: idLength } = readId(buffer, position);
  const { size, length: sizeLength } = readSize(buffer, position + idLength);
  return { id, size, dataStart: position + idLength + sizeLength };
}

// Filhos de um elemento mestre já inteiro em memória. Tamanho desconhecido ou que passa do fim
// vira erro: dentro de um payload lido por inteiro isso só acontece com dado corrompido.
function children(payload: Buffer, visit: (header: ElementHeader, data: Buffer) => void): void {
  let position = 0;
  while (position < payload.length) {
    const header = readHeader(payload, position);
    if (header.size === null || header.dataStart + header.size > payload.length) {
      throw new MkvFormatError("elemento maior que o contêiner");
    }
    visit(header, payload.subarray(header.dataStart, header.dataStart + header.size));
    position = header.dataStart + header.size;
  }
}

function uint(data: Buffer): number {
  if (data.length > 7) throw new MkvFormatError("inteiro grande demais");
  let value = 0;
  for (const byte of data) value = value * 256 + byte;
  return value;
}

function text(data: Buffer): string {
  const end = data.indexOf(0);
  return data.toString("utf8", 0, end < 0 ? data.length : end);
}

async function safeRead(readRange: ReadRange, start: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(start) || start < 0 || length <= 0) throw new MkvFormatError("posição inválida");
  return readRange(start, length);
}

interface SeekEntry { readonly id: number; readonly position: number }

function parseSeekHead(payload: Buffer): SeekEntry[] {
  const entries: SeekEntry[] = [];
  children(payload, (header, data) => {
    if (header.id !== ID.seek) return;
    let id: number | null = null;
    let position: number | null = null;
    children(data, (child, value) => {
      if (child.id === ID.seekId) id = uint(value);
      else if (child.id === ID.seekPosition) position = uint(value);
    });
    if (id !== null && position !== null) entries.push({ id, position });
  });
  return entries;
}

interface TrackInfo extends MkvSubtitleTrack { readonly type: number }

function parseTracks(payload: Buffer): TrackInfo[] {
  const tracks: TrackInfo[] = [];
  children(payload, (header, data) => {
    if (header.id !== ID.trackEntry) return;
    let number = 0, type = 0, codec = "", language = "eng", bcp47 = "", name = "";
    let isDefault = true, forced = false;
    children(data, (child, value) => {
      switch (child.id) {
        case ID.trackNumber: number = uint(value); break;
        case ID.trackType: type = uint(value); break;
        case ID.codecId: codec = text(value); break;
        case ID.language: language = text(value); break;
        case ID.languageBcp47: bcp47 = text(value); break;
        case ID.name: name = value.toString("utf8"); break;
        case ID.flagDefault: isDefault = uint(value) !== 0; break;
        case ID.flagForced: forced = uint(value) !== 0; break;
        default: break;
      }
    });
    if (number > 0) {
      tracks.push({ number, type, codec, language: bcp47 || language, name, forced, default: isDefault });
    }
  });
  return tracks;
}

interface CueEntry {
  readonly track: number;
  readonly time: number;
  readonly clusterPosition: number;
  readonly relativePosition: number;
  readonly duration: number | null;
}

function parseCues(payload: Buffer): CueEntry[] {
  const entries: CueEntry[] = [];
  let points = 0;
  children(payload, (header, data) => {
    if (header.id !== ID.cuePoint || points >= MAX_CUE_POINTS) return;
    points += 1;
    let time = 0;
    const positions: Omit<CueEntry, "time">[] = [];
    children(data, (child, value) => {
      if (child.id === ID.cueTime) { time = uint(value); return; }
      if (child.id !== ID.cueTrackPositions) return;
      let track = 0, cluster: number | null = null, relative: number | null = null;
      let duration: number | null = null;
      children(value, (item, field) => {
        if (item.id === ID.cueTrack) track = uint(field);
        else if (item.id === ID.cueClusterPosition) cluster = uint(field);
        else if (item.id === ID.cueRelativePosition) relative = uint(field);
        else if (item.id === ID.cueDuration) duration = uint(field);
      });
      // Sem posição relativa não dá para achar o bloco sem varrer o Cluster: faixa fora do escopo.
      if (track > 0 && cluster !== null && relative !== null) {
        positions.push({ track, clusterPosition: cluster, relativePosition: relative, duration });
      }
    });
    for (const position of positions) entries.push({ ...position, time });
  });
  return entries;
}

interface MkvIndex {
  readonly segmentStart: number;
  readonly timestampScale: number;
  readonly tracks: TrackInfo[];
  readonly cues: CueEntry[];
}

// Lê um elemento de primeiro nível pela posição (relativa aos dados do Segment), reaproveitando o
// começo do arquivo já lido quando ele cabe inteiro ali.
async function readTopElement(
  readRange: ReadRange,
  head: Buffer,
  segmentStart: number,
  position: number,
  expectedId: number,
  maxBytes: number
): Promise<Buffer> {
  const absolute = segmentStart + position;
  let window = absolute + 16 <= head.length ? head.subarray(absolute) : await safeRead(readRange, absolute, 16);
  const header = readHeader(window, 0);
  if (header.id !== expectedId || header.size === null) throw new MkvFormatError("elemento inesperado");
  if (header.size > maxBytes) throw new MkvFormatError("elemento grande demais");
  const total = header.dataStart + header.size;
  if (window.length < total) window = await safeRead(readRange, absolute, total);
  if (window.length < total) throw new MkvFormatError("arquivo truncado");
  return window.subarray(header.dataStart, total);
}

async function loadIndex(readRange: ReadRange): Promise<MkvIndex> {
  const head = await safeRead(readRange, 0, HEAD_BYTES);
  const ebml = readHeader(head, 0);
  if (ebml.id !== ID.ebml || ebml.size === null) throw new MkvFormatError("não é Matroska");
  const segment = readHeader(head, ebml.dataStart + ebml.size);
  if (segment.id !== ID.segment) throw new MkvFormatError("Segment ausente");
  const segmentStart = segment.dataStart;

  // Varre os elementos de primeiro nível que cabem no começo (SeekHead, Info, Tracks…) até o
  // primeiro Cluster; as posições achadas aqui valem mais que as do SeekHead.
  const positions = new Map<number, number>();
  let cursor = segmentStart;
  while (cursor + 4 < head.length) {
    let header: ElementHeader;
    try { header = readHeader(head, cursor); } catch { break; }
    if (header.id === ID.cluster || header.size === null) break;
    if (!positions.has(header.id)) positions.set(header.id, cursor - segmentStart);
    cursor = header.dataStart + header.size;
  }
  const seekHeadPosition = positions.get(ID.seekHead);
  if (seekHeadPosition !== undefined) {
    const seekHead = await readTopElement(readRange, head, segmentStart, seekHeadPosition, ID.seekHead, MAX_INFO_BYTES);
    for (const entry of parseSeekHead(seekHead)) {
      if (!positions.has(entry.id)) positions.set(entry.id, entry.position);
    }
  }

  const tracksPosition = positions.get(ID.tracks);
  const cuesPosition = positions.get(ID.cues);
  if (tracksPosition === undefined) throw new MkvFormatError("Tracks ausente");
  const tracks = parseTracks(
    await readTopElement(readRange, head, segmentStart, tracksPosition, ID.tracks, MAX_TRACKS_BYTES)
  );
  let timestampScale = 1_000_000;
  const infoPosition = positions.get(ID.info);
  if (infoPosition !== undefined) {
    const info = await readTopElement(readRange, head, segmentStart, infoPosition, ID.info, MAX_INFO_BYTES);
    children(info, (header, data) => {
      if (header.id === ID.timestampScale) timestampScale = uint(data);
    });
  }
  if (timestampScale <= 0) throw new MkvFormatError("TimestampScale inválido");
  const cues = cuesPosition === undefined ? [] : parseCues(
    await readTopElement(readRange, head, segmentStart, cuesPosition, ID.cues, MAX_CUES_BYTES)
  );
  return { segmentStart, timestampScale, tracks, cues };
}

// RangeError e afins nunca devem vazar: qualquer falha de parsing vira MkvFormatError.
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MkvFormatError) throw error;
    if (error instanceof RangeError || error instanceof TypeError) throw new MkvFormatError("dado corrompido");
    throw error;
  }
}

export async function listMkvSubtitleTracks(
  readRange: ReadRange
): Promise<{ tracks: MkvSubtitleTrack[] }> {
  return guarded(async () => {
    const index = await loadIndex(readRange);
    const indexed = new Set(index.cues.map((cue) => cue.track));
    return {
      tracks: index.tracks
        .filter((track) => track.type === SUBTITLE_TRACK_TYPE && SUPPORTED_CODECS.has(track.codec) &&
          indexed.has(track.number))
        .map(({ type: _type, ...track }) => track)
    };
  });
}

interface RawBlock { readonly data: Buffer; readonly duration: number | null }

// Só o número da faixa importa aqui: o tempo vem do CueTime, não do timestamp relativo do bloco.
function blockData(payload: Buffer, trackNumber: number): Buffer | null {
  const track = readSize(payload, 0);
  if (track.size !== trackNumber) return null;
  const at = track.length;
  if (payload.length < at + 3) throw new MkvFormatError("bloco truncado");
  const flags = payload[at + 2]!;
  if ((flags & 0x06) !== 0) return null; // lacing: legenda não usa, descarta
  return payload.subarray(at + 3);
}

// Decodifica um SimpleBlock/BlockGroup já inteiro (cabeçalho incluído) em `element`.
function decodeBlockElement(element: Buffer, trackNumber: number): RawBlock | null {
  const header = readHeader(element, 0);
  const payload = element.subarray(header.dataStart, header.dataStart + (header.size ?? 0));
  if (header.id === ID.simpleBlock) {
    const data = blockData(payload, trackNumber);
    return data ? { data, duration: null } : null;
  }
  let data: Buffer | null = null;
  let duration: number | null = null;
  children(payload, (child, value) => {
    if (child.id === ID.block) data = blockData(value, trackNumber);
    else if (child.id === ID.blockDuration) duration = uint(value);
  });
  const found = data as Buffer | null;
  return found ? { data: found, duration } : null;
}

// Candidato a elemento começando em window[k]: cabeçalho coerente e número de faixa certo.
// Devolve o tamanho total do elemento (cabeçalho + dados) ou null se não parece um bloco.
function candidateLength(window: Buffer, k: number, trackNumber: number): number | null {
  try {
    const header = readHeader(window, k);
    if (header.size === null || header.size > MAX_BLOCK_BYTES || header.size < 4) return null;
    if (header.id === ID.simpleBlock) {
      if (readSize(window, header.dataStart).size !== trackNumber) return null;
    } else if (header.id === ID.blockGroup) {
      const inner = readHeader(window, header.dataStart);
      if (inner.id !== ID.block || inner.size === null || inner.size > header.size) return null;
      if (readSize(window, inner.dataStart).size !== trackNumber) return null;
    } else return null;
    return header.dataStart - k + header.size;
  } catch {
    return null;
  }
}

// UMA leitura por cue. O tamanho do campo de tamanho do Cluster (1..8 bytes) é desconhecido sem
// ler o cabeçalho dele, então a janela começa no menor início possível e testa os 8 deslocamentos
// (cada ida ao servidor custa ~0,9 s no Real-Debrid; ler o cabeçalho do Cluster dobrava isso).
async function readBlockNear(
  readRange: ReadRange,
  segmentStart: number,
  entry: CueEntry,
  trackNumber: number
): Promise<RawBlock | null> {
  const windowStart = segmentStart + entry.clusterPosition + 4 + 1 + entry.relativePosition;
  const window = await safeRead(readRange, windowStart, 7 + BLOCK_PEEK_BYTES);
  for (let k = 0; k < 8; k += 1) {
    const length = candidateLength(window, k, trackNumber);
    if (length === null) continue;
    let element = window.subarray(k, k + length);
    if (element.length < length) {
      element = await safeRead(readRange, windowStart + k, length);
      if (element.length < length) throw new MkvFormatError("bloco truncado");
    }
    return decodeBlockElement(element, trackNumber);
  }
  return null;
}

// Concorrência limitada sem dependência: N trabalhadores puxando do mesmo índice.
async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const current = next;
      next += 1;
      results[current] = await work(items[current]!);
    }
  });
  await Promise.all(runners);
  return results;
}

function blockText(codec: string, data: Buffer): string | null {
  const source = data.toString("utf8").replace(/\r\n?/g, "\n");
  if (codec === "S_TEXT/ASS" || codec === "S_TEXT/SSA") {
    let from = 0;
    for (let commas = 0; commas < 8; commas += 1) {
      from = source.indexOf(",", from);
      if (from < 0) return null;
      from += 1;
    }
    const raw = source.slice(from);
    // Eventos de desenho (\p1..\p9 num override) são vetores, não fala.
    if (/\{[^}]*\\p[1-9][^}]*\}/.test(raw)) return null;
    // A letra da abertura vem em duas camadas no mesmo tempo (romaji/kanji e a tradução): na tela
    // única do player elas se empilham. Fica só a tradução. O estilo é o 3º campo do payload.
    const style = source.split(",", 3)[2] ?? "";
    if (/romaji|romanji|kanji|karaoke|\bkara\b/i.test(style)) return null;
    return assTextToVtt(raw) || null;
  }
  if (codec === "S_TEXT/WEBVTT") return source.replace(/\n{2,}/g, "\n").trim() || null;
  return source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n{2,}/g, "\n").trim() || null;
}

function vttTime(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds));
  const ms = total % 1_000;
  const seconds = Math.floor(total / 1_000) % 60;
  const minutes = Math.floor(total / 60_000) % 60;
  const hours = Math.floor(total / 3_600_000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(hours)}:${two(minutes)}:${two(seconds)}.${String(ms).padStart(3, "0")}`;
}

export async function extractMkvSubtitleVtt(readRange: ReadRange, trackNumber: number): Promise<string> {
  return guarded(async () => {
    const index = await loadIndex(readRange);
    const track = index.tracks.find((candidate) => candidate.number === trackNumber &&
      candidate.type === SUBTITLE_TRACK_TYPE && SUPPORTED_CODECS.has(candidate.codec));
    if (!track) throw new MkvFormatError("faixa de legenda não encontrada");
    const entries = index.cues.filter((cue) => cue.track === trackNumber);
    if (entries.length === 0) throw new MkvFormatError("faixa sem índice");

    const scaleMs = index.timestampScale / 1_000_000;

    // Uma fala cuja leitura falhou mesmo depois das novas tentativas é perdida sozinha; só um
    // volume grande de falhas (servidor fora do ar, link expirado) condena a extração.
    let failures = 0;
    const raw = await mapLimited(entries, READ_CONCURRENCY, async (entry) => {
      let block: RawBlock | null;
      try {
        block = await readBlockNear(readRange, index.segmentStart, entry, trackNumber);
      } catch (error) {
        failures += 1;
        if (failures > Math.max(3, entries.length * 0.1)) throw error;
        return null;
      }
      if (!block) return null;
      const body = blockText(track.codec, block.data);
      if (body === null) return null;
      // CueTime do mkvmerge é o tempo absoluto do bloco de legenda.
      const start = entry.time * scaleMs;
      const ticks = block.duration ?? entry.duration;
      return { start, end: ticks === null ? null : start + ticks * scaleMs, body };
    });

    const cues = raw.filter((cue): cue is { start: number; end: number | null; body: string } => cue !== null)
      .sort((a, b) => a.start - b.start);
    const lines = cues.flatMap((cue, position) => {
      let end = cue.end;
      if (end === null) {
        // Sem duração: 4 s, mas nunca por cima da próxima fala.
        const nextStart = cues.slice(position + 1).find((other) => other.start > cue.start)?.start;
        end = cue.start + FALLBACK_CUE_MS;
        if (nextStart !== undefined) end = Math.min(end, nextStart);
      }
      if (end <= cue.start) return [];
      return [`${vttTime(cue.start)} --> ${vttTime(end)}\n${cue.body}`];
    });
    // Faixa embutida também pode ter sido gravada já estragada (ver `repairDoubleEncodedUtf8`).
    return repairDoubleEncodedUtf8(`WEBVTT\n\n${lines.join("\n\n")}${lines.length > 0 ? "\n" : ""}`);
  });
}
