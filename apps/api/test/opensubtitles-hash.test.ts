import assert from "node:assert/strict";
import test from "node:test";
import { computeRemoteFileHash, openSubtitlesMovieHash } from "../src/stremio/opensubtitles-hash.js";

/**
 * Referência INDEPENDENTE do algoritmo (não reaproveita `readBigUInt64LE`): monta cada palavra
 * de 8 bytes a partir de duas leituras de 32 bits (`readUInt32LE`), combinadas em BigInt.
 * Se as duas implementações concordarem, o algoritmo em si está certo — não só a mesma conta
 * repetida duas vezes.
 */
function referenceHash(size: bigint, chunks: readonly Buffer[]): string {
  const mask = (1n << 64n) - 1n;
  let sum = size & mask;
  for (const chunk of chunks) {
    for (let offset = 0; offset + 8 <= chunk.length; offset += 8) {
      const low = BigInt(chunk.readUInt32LE(offset));
      const high = BigInt(chunk.readUInt32LE(offset + 4));
      sum = (sum + ((high << 32n) | low)) & mask;
    }
  }
  return sum.toString(16).padStart(16, "0");
}

function syntheticBuffer(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  // Padrão determinístico (não tudo zero): zero em toda parte esconderia um bug de offset/ordem
  // de bytes, porque a soma continuaria batendo por acidente.
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 7 + 3) % 256;
  return buffer;
}

test("openSubtitlesMovieHash bate com uma implementação independente do mesmo algoritmo", () => {
  const size = 200_000;
  const data = syntheticBuffer(size);
  const first = data.subarray(0, 65_536);
  const last = data.subarray(size - 65_536);
  const expected = referenceHash(BigInt(size), [first, last]);
  assert.equal(openSubtitlesMovieHash(BigInt(size), first, last), expected);
  assert.match(expected, /^[0-9a-f]{16}$/);
});

test("openSubtitlesMovieHash: vetor fixo e pequeno, para travar a ordem de bytes/soma", () => {
  // 16 bytes (dois blocos de 8) com valores conhecidos, tamanho pequeno para a conta caber de
  // cabeça: bloco 1 = 1 (little-endian, só o byte menos significativo), bloco 2 = 2.
  const first = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
  const last = Buffer.alloc(0);
  const size = 16n;
  // size(16) + bloco1(1) + bloco2(2) = 19.
  assert.equal(openSubtitlesMovieHash(size, first, last), (19).toString(16).padStart(16, "0"));
});

function fakeFetch(total: number, data: Buffer, options: { ignoreRangeOnTail?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-length": String(total) } });
    }
    const rangeHeader = new Headers(init?.headers).get("range");
    const match = rangeHeader ? /^bytes=(\d+)-(\d+)$/.exec(rangeHeader) : null;
    if (!match) return new Response(new Uint8Array(data), { status: 200 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (options.ignoreRangeOnTail && start > 0) {
      // Simula um servidor que ignora Range e sempre devolve o arquivo inteiro do começo.
      return new Response(new Uint8Array(data), { status: 200 });
    }
    const slice = data.subarray(start, end + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${total}` }
    });
  }) as typeof fetch;
}

test("computeRemoteFileHash lê só as pontas via Range e bate com o hash de referência", async () => {
  const size = 300_000;
  const data = syntheticBuffer(size);
  const expected = openSubtitlesMovieHash(
    BigInt(size), data.subarray(0, 65_536), data.subarray(size - 65_536)
  );
  const result = await computeRemoteFileHash("https://1.2.3.4/video.mkv", fakeFetch(size, data));
  assert.deepEqual(result, { hash: expected, size });
});

test("computeRemoteFileHash recusa quando o servidor ignora Range no trecho final", async () => {
  const size = 300_000;
  const data = syntheticBuffer(size);
  const result = await computeRemoteFileHash(
    "https://1.2.3.4/video.mkv", fakeFetch(size, data, { ignoreRangeOnTail: true })
  );
  // Sem 206 no trecho final não há garantia de que os bytes recebidos são o FIM do arquivo — usar
  // o começo duas vezes nunca bateria com o hash real, então a função desiste em vez de mentir.
  assert.equal(result, null);
});

test("computeRemoteFileHash devolve null sem Content-Length, sem lançar", async () => {
  const fetchImpl = (async () => new Response(null, { status: 200 })) as typeof fetch;
  assert.equal(await computeRemoteFileHash("https://1.2.3.4/video.mkv", fetchImpl), null);
});

test("computeRemoteFileHash devolve null quando a rede falha, sem propagar o erro", async () => {
  const fetchImpl = (async () => { throw new Error("rede indisponível"); }) as typeof fetch;
  assert.equal(await computeRemoteFileHash("https://1.2.3.4/video.mkv", fetchImpl), null);
});

test("computeRemoteFileHash recusa URL insegura (não-HTTPS) antes de qualquer fetch", async () => {
  let chamou = false;
  const fetchImpl = (async () => { chamou = true; return new Response(null, { status: 200 }); }) as typeof fetch;
  assert.equal(await computeRemoteFileHash("http://1.2.3.4/video.mkv", fetchImpl), null);
  assert.equal(chamou, false);
});
