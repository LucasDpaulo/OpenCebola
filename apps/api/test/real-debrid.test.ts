import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { clearTorrentIdCache, RealDebridClient } from "../src/stremio/real-debrid.js";
import { RealDebridError } from "../src/stremio/types.js";

const hash = "0123456789abcdef0123456789abcdef01234567";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// O cache de infoHash → torrentId é global de módulo (de propósito: precisa sobreviver entre
// requisições). Isso significa que ele sobrevive entre testes também, então cada teste precisa
// partir de um cache vazio pra não vazar estado de um caso pro outro.
beforeEach(() => {
  clearTorrentIdCache();
});

test("RealDebridClient adiciona torrent, seleciona arquivos e informa pendência", async () => {
  const requests: { url: string; method: string; body: string | null }[] = [];
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
      if (String(input).endsWith("/torrents?limit=100")) return json([]);
      if (String(input).endsWith("/torrents/addMagnet")) return json({ id: "torrent-1" }, 201);
      if (String(input).endsWith("/torrents/info/torrent-1")) {
        return json({ id: "torrent-1", hash, status: "waiting_files_selection", progress: 0 });
      }
      if (String(input).endsWith("/torrents/selectFiles/torrent-1")) return new Response(null, { status: 204 });
      throw new Error("unexpected request");
    }
  });
  assert.deepEqual(await client.resolveTorrent(hash, 0), { status: "pending", progress: 0 });
  assert.equal(requests[1]?.body?.includes("magnet%3A%3Fxt%3Durn%3Abtih%3A"), true);
  assert.equal(requests[3]?.body, "files=all");
});

test("RealDebridClient libera URL HTTPS quando o torrent já está pronto", async () => {
  let unrestrictBody: string | null = null;
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input, init) => {
      if (String(input).endsWith("/torrents?limit=100")) return json([{ id: "torrent-1", hash }]);
      if (String(input).endsWith("/torrents/info/torrent-1")) {
        return json({ id: "torrent-1", hash, status: "downloaded", progress: 100, links: ["https://1.1.1.1/restricted"] });
      }
      if (String(input).endsWith("/unrestrict/link")) {
        unrestrictBody = typeof init?.body === "string" ? init.body : null;
        return json({ download: "https://1.0.0.1/video.mp4" });
      }
      throw new Error("unexpected request");
    }
  });
  assert.deepEqual(await client.resolveTorrent(hash, 0), {
    status: "ready", url: "https://1.0.0.1/video.mp4"
  });
  assert.equal(unrestrictBody, "link=https%3A%2F%2F1.1.1.1%2Frestricted");
  assert.equal(unrestrictBody?.includes("remote"), false);
});

test("RealDebridClient não expõe resposta de autenticação", async () => {
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async () => json({ error: "bad token" }, 401)
  });
  await assert.rejects(() => client.resolveTorrent(hash, null), (error: unknown) =>
    error instanceof RealDebridError && error.code === "AUTHENTICATION_FAILED" && !error.message.includes("bad token")
  );
});

test("RealDebridClient identifica tráfego remoto esgotado sem expor o link", async () => {
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      if (String(input).endsWith("/torrents?limit=100")) return json([{ id: "torrent-1", hash }]);
      if (String(input).endsWith("/torrents/info/torrent-1")) {
        return json({ id: "torrent-1", hash, status: "downloaded", progress: 100, links: ["https://1.1.1.1/restricted"] });
      }
      if (String(input).endsWith("/unrestrict/link")) return json({ error_code: 23 }, 403);
      throw new Error("unexpected request");
    }
  });
  await assert.rejects(() => client.resolveTorrent(hash, null), (error: unknown) =>
    error instanceof RealDebridError && error.code === "TRAFFIC_EXHAUSTED" && !error.message.includes("restricted")
  );
});

test("RealDebridClient identifica arquivo bloqueado e impede repetição inútil", async () => {
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      if (String(input).endsWith("/torrents?limit=100")) return json([]);
      if (String(input).endsWith("/torrents/addMagnet")) return json({ error_code: 35 }, 451);
      throw new Error("unexpected request");
    }
  });
  await assert.rejects(() => client.resolveTorrent(hash, null), (error: unknown) =>
    error instanceof RealDebridError && error.code === "INFRINGING_FILE" &&
    error.detail === "/torrents/addMagnet HTTP 451 error_code 35"
  );
});

// UNAVAILABLE era lançado tanto para falha de rede quanto para QUALQUER status ruim do
// Real-Debrid, e o status original era descartado. Na produção isso virava um 503 mudo: sem
// saber se foi 429, 500 ou timeout, não há o que investigar. O detalhe não pode conter token,
// link nem título — só o endpoint e o status.
test("RealDebridClient preserva o status de origem para diagnóstico, sem vazar credencial", async () => {
  const client = new RealDebridClient({
    token: "token-secreto",
    fetch: async () => json({ error: "internal", error_code: 99 }, 500)
  });

  await assert.rejects(
    () => client.resolveTorrent(hash, null),
    (error: unknown) => {
      assert.ok(error instanceof RealDebridError);
      assert.equal(error.code, "UNAVAILABLE");
      assert.match(error.detail ?? "", /500/);
      assert.match(error.detail ?? "", /torrents/);
      assert.doesNotMatch(error.detail ?? "", /token-secreto/);
      return true;
    }
  );
});

test("RealDebridClient marca falha de rede de forma distinta de status ruim", async () => {
  const client = new RealDebridClient({
    token: "token-secreto",
    fetch: async () => { throw new Error("getaddrinfo ENOTFOUND"); }
  });

  await assert.rejects(
    () => client.resolveTorrent(hash, null),
    (error: unknown) => {
      assert.ok(error instanceof RealDebridError);
      assert.equal(error.code, "UNAVAILABLE");
      assert.match(error.detail ?? "", /rede|network/i);
      assert.doesNotMatch(error.detail ?? "", /token-secreto/);
      return true;
    }
  );
});

// Medido em 26/08/2026 no aparelho: Ted.Lasso...[rartv].rar e Project.Hail.Mary.PROPER...rar
// chegavam ao player como `status: "ready"`, e o libVLC ficava em `evento=parado`, vout=0, sem
// faixa nenhuma e sem mensagem. Lançamento "scene" vem empacotado, e links[0] era entregue sem
// ninguém perguntar se aquilo era vídeo.
test("RealDebridClient recusa arquivo que não é vídeo em vez de entregar link que não toca", async () => {
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      if (String(input).endsWith("/torrents?limit=100")) return json([{ id: "torrent-1", hash }]);
      if (String(input).endsWith("/torrents/info/torrent-1")) {
        return json({
          id: "torrent-1", hash, status: "downloaded", progress: 100,
          files: [
            { id: 1, path: "/Ted.Lasso.S01E01[rartv].rar", bytes: 5_808_263_216, selected: 1 },
            { id: 2, path: "/Ted.Lasso.S01E01.nfo", bytes: 2_000, selected: 1 }
          ],
          links: ["https://real-debrid.com/d/aaa", "https://real-debrid.com/d/bbb"]
        });
      }
      throw new Error("unexpected request");
    }
  });
  await assert.rejects(() => client.resolveTorrent(hash, null), (error: unknown) =>
    error instanceof RealDebridError && error.code === "NOT_PLAYABLE_FILE"
  );
});

test("RealDebridClient escolhe o vídeo quando o torrent traz lixo junto, ignorando o índice pedido", async () => {
  let liberado: string | null = null;
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input, init) => {
      if (String(input).endsWith("/torrents?limit=100")) return json([{ id: "torrent-1", hash }]);
      if (String(input).endsWith("/torrents/info/torrent-1")) {
        return json({
          id: "torrent-1", hash, status: "downloaded", progress: 100,
          files: [
            { id: 1, path: "/Sample/amostra.nfo", bytes: 1_000, selected: 1 },
            { id: 2, path: "/Filme.2026.1080p.mkv", bytes: 9_000_000_000, selected: 1 }
          ],
          links: ["https://real-debrid.com/d/nfo", "https://real-debrid.com/d/mkv"]
        });
      }
      if (String(input).endsWith("/unrestrict/link")) {
        liberado = typeof init?.body === "string" ? init.body : null;
        return json({ download: "https://sao1.download.real-debrid.com/x/Filme.mkv" });
      }
      throw new Error("unexpected request");
    }
  });
  // fileIdx 0 aponta para o .nfo. O pedido do cliente não pode vencer a realidade do arquivo.
  const r = await client.resolveTorrent(hash, 0);
  assert.equal(r.status, "ready");
  assert.equal(liberado?.includes("d%2Fmkv"), true);
});

// Torrent de um arquivo só continua funcionando sem a lista `files`: contas antigas e respostas
// abreviadas do Real-Debrid não a trazem, e quebrar aí seria pior que o defeito consertado.
test("RealDebridClient mantém o comportamento antigo quando o Real-Debrid não lista arquivos", async () => {
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      if (String(input).endsWith("/torrents?limit=100")) return json([{ id: "torrent-1", hash }]);
      if (String(input).endsWith("/torrents/info/torrent-1")) {
        return json({ id: "torrent-1", hash, status: "downloaded", progress: 100, links: ["https://real-debrid.com/d/só-um"] });
      }
      if (String(input).endsWith("/unrestrict/link")) return json({ download: "https://sao1.download.real-debrid.com/x/y.mkv" });
      throw new Error("unexpected request");
    }
  });
  assert.equal((await client.resolveTorrent(hash, null)).status, "ready");
});

// "Continuar assistir" e troca de fonte/player resolvem o MESMO infoHash de novo. Sem cache, cada
// resolve pagava um GET /torrents?limit=100 só pra reencontrar um torrentId já visto.
test("RealDebridClient guarda o torrentId em cache e não relista no resolve seguinte do mesmo hash", async () => {
  const listagens: string[] = [];
  const infoCalls: string[] = [];
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/torrents?limit=100")) {
        listagens.push(url);
        return json([]);
      }
      if (url.endsWith("/torrents/addMagnet")) return json({ id: "torrent-1" }, 201);
      if (url.endsWith("/torrents/info/torrent-1")) {
        infoCalls.push(url);
        return json({ id: "torrent-1", hash, status: "downloaded", progress: 100, links: ["https://real-debrid.com/d/video.mkv"] });
      }
      if (url.endsWith("/unrestrict/link")) return json({ download: "https://sao1.download.real-debrid.com/x/video.mkv" });
      throw new Error("unexpected request");
    }
  });

  const primeiro = await client.resolveTorrent(hash, null);
  assert.equal(primeiro.status, "ready");
  assert.equal(listagens.length, 1, "1º resolve não achou o torrent pronto e listou antes de addMagnet");

  const segundo = await client.resolveTorrent(hash, null);
  assert.equal(segundo.status, "ready");
  assert.equal(listagens.length, 1, "2º resolve do mesmo hash não pode relistar: usa o torrentId em cache direto");
  assert.equal(infoCalls.length, 2, "cada resolve ainda confere o #info do torrentId (cache ou não)");
});

// Id em cache pode ficar velho: o torrent pode ter sido apagado/expirado na conta Real-Debrid
// entre um resolve e outro. Isso não pode quebrar o player — só custar a listagem de volta.
test("RealDebridClient invalida o cache e cai no fallback quando o torrentId salvo não é mais encontrado", async () => {
  const listagens: string[] = [];
  let idVelhoSumiu = false;
  const client = new RealDebridClient({
    token: "private-token-with-enough-characters",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/torrents?limit=100")) {
        listagens.push(url);
        return json([]);
      }
      if (url.endsWith("/torrents/addMagnet")) {
        return json({ id: idVelhoSumiu ? "torrent-2" : "torrent-1" }, 201);
      }
      if (url.endsWith("/torrents/info/torrent-1")) {
        if (idVelhoSumiu) return json({ error: "unknown_resource" }, 404);
        return json({ id: "torrent-1", hash, status: "downloaded", progress: 100, links: ["https://real-debrid.com/d/a.mkv"] });
      }
      if (url.endsWith("/torrents/info/torrent-2")) {
        return json({ id: "torrent-2", hash, status: "downloaded", progress: 100, links: ["https://real-debrid.com/d/b.mkv"] });
      }
      if (url.endsWith("/unrestrict/link")) return json({ download: "https://sao1.download.real-debrid.com/x/video.mkv" });
      throw new Error("unexpected request");
    }
  });

  const primeiro = await client.resolveTorrent(hash, null);
  assert.equal(primeiro.status, "ready");
  assert.equal(listagens.length, 1);

  idVelhoSumiu = true;
  const segundo = await client.resolveTorrent(hash, null);
  assert.equal(segundo.status, "ready", "id velho não pode impedir o resolve: cai no fallback e resolve mesmo assim");
  assert.equal(listagens.length, 2, "o #info(torrentId em cache) veio 404, então caiu de volta pra listagem");
});
