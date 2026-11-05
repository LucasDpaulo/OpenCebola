import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { StremioAddonGateway } from "../src/stremio/gateway.js";
import { StremioIntegrationError, type AddonDescriptor } from "../src/stremio/types.js";

// Caractere de controle montado em tempo de execução para não depender de escapes no fonte.
const controle = String.fromCharCode(1);

function descriptor(overrides: {
  id?: string;
  resources?: string[];
  types?: ("movie" | "series")[];
  idPrefixes?: string[];
  // type é string (não mais "movie" | "series"): addonCatalogSchema aceita qualquer tipo de
  // catálogo hoje, igual ao manifesto real que chega do Stremio.
  catalogs?: { id: string; type: string; name?: string }[];
  transportUrl?: string;
} = {}): AddonDescriptor {
  return {
    manifest: {
      id: overrides.id ?? "org.example.addon",
      version: "1.0.0",
      name: "Add-on de teste",
      resources: overrides.resources ?? ["catalog", "meta", "stream"],
      types: overrides.types ?? ["movie", "series"],
      ...(overrides.idPrefixes ? { idPrefixes: overrides.idPrefixes } : {}),
      catalogs: overrides.catalogs ?? []
    },
    transportUrl: overrides.transportUrl ?? "https://addon.example/manifest.json"
  };
}

test("gateway.streams aceita só HTTPS público na 443 e sanitiza labels de payload hostil", async () => {
  const addon = descriptor({ id: "org.example.hostil", idPrefixes: ["tt"] });
  // IPs literais evitam resolução DNS dentro de validatePublicHttpsUrl.
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        { url: "magnet:?xt=urn:btih:0000", title: "P2P" },
        { url: "http://1.1.1.1/plain.mp4", title: "Sem TLS" },
        { url: "https://10.0.0.1/lan.mp4", title: "Rede interna" },
        { url: "https://1.1.1.1:8443/porta.mp4", title: "Porta alternativa" },
        { url: "javascript:alert(1)", title: "XSS" },
        { url: "https://1.1.1.1/ok.mp4", title: `<b>Dublado</b>${controle}1080p` },
        { url: "https://1.0.0.1/ok2.mp4", name: "Legendado" },
        "não é objeto",
        { title: "sem url" },
        { url: 42 },
        { url: "https://1.0.0.1/anon.mp4" }
      ]
    })
  });
  const result = await gateway.streams([addon], "movie", "tt123");
  assert.deepEqual(result.streams.map((stream) => stream.url), [
    "https://1.1.1.1/ok.mp4",
    "https://1.0.0.1/ok2.mp4",
    "https://1.0.0.1/anon.mp4"
  ]);
  assert.deepEqual(result.streams.map((stream) => stream.label), [
    "Dublado 1080p",
    "Legendado",
    "Opção 11"
  ]);
  // Nada das URLs recusadas pode vazar na resposta entregue ao navegador.
  const serializado = JSON.stringify(result);
  for (const recusado of ["magnet", "10.0.0.1", "8443", "javascript", "http://"]) {
    assert.equal(serializado.includes(recusado), false);
  }
});

test("gateway.streams aceita http público só quando allowInsecureStreams está ligado", async () => {
  const addon = descriptor({ id: "org.example.insecure", idPrefixes: ["tt"] });
  const payloadMisto = {
    streams: [
      { url: "http://1.1.1.1/publico.mp4", title: "HTTP público" },
      { url: "https://1.1.1.1/seguro.mp4", title: "HTTPS público" },
      { url: "http://10.0.0.1/privado.mp4", title: "HTTP privado" },
      { url: "magnet:?xt=urn:btih:0000", title: "P2P" },
      { title: "Sem url" }
    ]
  };

  // Default (flag ausente): comportamento de sempre, só HTTPS público passa.
  const padrao = new StremioAddonGateway({ fetchJson: async () => payloadMisto });
  const resultadoPadrao = await padrao.streams([addon], "movie", "tt-insecure");
  assert.deepEqual(resultadoPadrao.streams.map((stream) => stream.url), [
    "https://1.1.1.1/seguro.mp4"
  ]);

  // Flag ligada: HTTP público passa a ser aceito, mas IP privado e magnet continuam bloqueados.
  const liberado = new StremioAddonGateway({
    fetchJson: async () => payloadMisto,
    allowInsecureStreams: true
  });
  const resultadoLiberado = await liberado.streams([addon], "movie", "tt-insecure");
  assert.deepEqual(resultadoLiberado.streams.map((stream) => stream.url), [
    "http://1.1.1.1/publico.mp4",
    "https://1.1.1.1/seguro.mp4"
  ]);
});

test("gateway.subtitles consulta somente addons compatíveis e sanitiza a lista", async () => {
  const addon = descriptor({
    id: "org.example.legendas",
    resources: ["subtitles"],
    idPrefixes: ["tt"],
    transportUrl: "https://legendas.example/manifest.json"
  });
  const ignorado = descriptor({ id: "org.example.sem-legendas", resources: ["stream"] });
  const chamadas: string[] = [];
  const gateway = new StremioAddonGateway({ fetchJson: async (url) => {
    chamadas.push(url);
    return { subtitles: [
      { id: "pt-BR", lang: "por", url: "https://1.1.1.1/subtitle.srt", label: "<b>Português</b>" },
      { id: "insegura", lang: "en", url: "http://1.1.1.1/subtitle.srt" },
      { id: "local", lang: "en", url: "https://127.0.0.1/subtitle.srt" },
      null
    ] };
  }});
  const result = await gateway.subtitles([addon, ignorado], "series", "tt123:1:1");
  assert.deepEqual(chamadas, ["https://legendas.example/subtitles/series/tt123%3A1%3A1.json"]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: createHash("sha256").update("org.example.legendas\0https://1.1.1.1/subtitle.srt").digest("base64url").slice(0, 24),
    addonName: "Add-on de teste",
    label: "Português",
    language: "por",
    url: "https://1.1.1.1/subtitle.srt"
  });
});

test("gateway.subtitles anexa o extra do Stremio (videoHash/videoSize/filename) ao caminho", async () => {
  const addon = descriptor({
    id: "org.stremio.opensubtitlesv3",
    resources: ["subtitles"],
    idPrefixes: ["tt"],
    transportUrl: "https://opensubtitles-v3.strem.io/manifest.json"
  });
  const chamadas: string[] = [];
  const gateway = new StremioAddonGateway({ fetchJson: async (url) => {
    chamadas.push(url);
    return { subtitles: [] };
  }});
  await gateway.subtitles([addon], "movie", "tt123", {
    videoHash: "abcdef0123456789",
    videoSize: "123456",
    filename: "Filme 2024.mkv"
  });
  assert.equal(
    chamadas[0],
    "https://opensubtitles-v3.strem.io/subtitles/movie/tt123/" +
      "videoHash=abcdef0123456789&videoSize=123456&filename=Filme%202024.mkv.json"
  );
});

test("gateway.subtitles do OpenSubtitles usa subtitleFileName como details e marca hash/fps", async () => {
  const addon = descriptor({
    id: "org.stremio.opensubtitlesv3",
    resources: ["subtitles"],
    idPrefixes: ["tt"],
    transportUrl: "https://opensubtitles-v3.strem.io/manifest.json"
  });
  const gateway = new StremioAddonGateway({ fetchJson: async () => ({
    subtitles: [
      {
        id: "1", lang: "pob", url: "https://1.1.1.1/hash.srt",
        subtitleFileName: "Filme.2024.1080p.BluRay-CtrlHD.srt", m: "h", fpsMilli: 23980
      },
      {
        id: "2", lang: "pob", url: "https://1.1.1.1/sem-hash.srt",
        movieReleaseName: "Filme.2024.720p.WEB-DL-Outro"
      }
    ]
  }) });
  const result = await gateway.subtitles([addon], "movie", "tt123");
  assert.deepEqual(result.map((s) => ({
    details: s.details, hashMatch: s.hashMatch, fps: s.fps
  })), [
    { details: "Filme.2024.1080p.BluRay-CtrlHD.srt", hashMatch: true, fps: 23.98 },
    { details: "Filme.2024.720p.WEB-DL-Outro", hashMatch: undefined, fps: undefined }
  ]);
});

test("gateway.streams extrai filename/videoSize de behaviorHints e sanitiza caminho", async () => {
  const addon = descriptor({ id: "org.example.hints" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [{
        url: "https://1.1.1.1/filme.mp4",
        title: "Fonte",
        behaviorHints: { filename: "../etc/Filme.2024.1080p-Grupo.mkv", videoSize: 123456 }
      }]
    })
  });
  const result = await gateway.streams([addon], "movie", "tt1");
  assert.equal(result.streams[0]?.filename, "Filme.2024.1080p-Grupo.mkv");
  assert.equal(result.streams[0]?.videoSize, 123456);
});

test("gateway.streams preserva infoHash como opção para o Real-Debrid, sem fabricar URL", async () => {
  const addon = descriptor({ id: "org.example.torrent", idPrefixes: ["tt"] });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [{
        infoHash: "0123456789abcdef0123456789abcdef01234567",
        fileIdx: 3,
        name: "Fonte\n1080p",
        title: "Filme de teste\n👤 42 💾 2.5 GB ⚙️ Exemplo"
      }]
    })
  });
  const result = await gateway.streams([addon], "movie", "tt123");
  // Sem `sources` do add-on, o motor local recebe a lista pública de trackers (ver torrent-trackers.ts).
  const trackers = (result.streams[0] as { trackers?: string[] } | undefined)?.trackers ?? [];
  assert.ok(trackers.length > 0);
  assert.deepEqual(result.streams.map(({ trackers: _trackers, ...stream }: { trackers?: unknown }) => stream), [{
    id: createHash("sha256").update("org.example.torrent\0" +
      "0123456789abcdef0123456789abcdef01234567\0" + "3").digest("hex").slice(0, 32),
    kind: "torrent",
    url: null,
    addonId: "org.example.torrent",
    addonName: "Add-on de teste",
    label: "Filme de teste",
    infoHash: "0123456789abcdef0123456789abcdef01234567",
    fileIdx: 3,
    quality: "1080p",
    sizeLabel: "2.5 GB",
    seeders: 42,
    source: "Exemplo",
    mayNotPlay: false,
    // Este add-on de teste não usa etiqueta de debrid, então não há o que afirmar sobre cache.
    readyNow: null,
    // Sem bandeira no title: o release não declara idioma, e é o áudio original do conteúdo.
    audioLanguages: [],
    subtitleLanguages: [],
    dubbed: false
  }]);
});

test("gateway preserva os torrents reais do ThePirateBay+ para resolução pelo Real-Debrid", async () => {
  const base = descriptor({
    id: "com.stremio.thepiratebay.plus",
    resources: ["stream"],
    idPrefixes: ["tt"],
    transportUrl: "https://thepiratebay-plus.strem.fun/manifest.json"
  });
  const tpb: AddonDescriptor = { ...base, manifest: { ...base.manifest, name: "ThePirateBay+" } };
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [{
        name: "TPB+",
        title: "The.Bear.S02.COMPLETE.1080p.HULU.WEB.h264-EDITH[TGx]\n" +
          "The.Bear.S02E02.1080p.WEB.h264-EDITH.mkv\n📺 1080p\n👤 708 💾 1.17 GB",
        infoHash: "3ef16a3437fd7b35c415d04f6ca67516e252c791",
        fileIdx: 2
      }]
    })
  });

  const result = await gateway.streams([tpb], "series", "tt14452776:2:2");

  assert.equal(result.streams.length, 1);
  assert.deepEqual({
    addonName: result.streams[0]?.addonName,
    label: result.streams[0]?.label,
    seeders: result.streams[0]?.seeders,
    quality: result.streams[0]?.quality,
    kind: result.streams[0]?.kind
  }, {
    addonName: "ThePirateBay+",
    label: "The.Bear.S02.COMPLETE.1080p.HULU.WEB.h264-EDITH[TGx]",
    seeders: 708,
    quality: "1080p",
    kind: "torrent"
  });
});

test("gateway oferece fallback seguro pelo navegador e remove pseudo-stream ERROR do Orion", async () => {
  const torrentio = descriptor({
    id: "com.stremio.torrentio.addon",
    resources: ["stream"],
    transportUrl: "https://torrentio.strem.fun/realdebrid=private-test-token/manifest.json"
  });
  const orion = descriptor({ id: "org.community.orion", resources: ["stream"] });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({ streams: [{ url: "https://1.1.1.1/error.mp4", name: "⚠️ ERROR!" }] })
  });

  const targets = await gateway.browserStreamTargets([torrentio, orion], "series", "tt10986410:1:1");
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.addonId, "com.stremio.torrentio.addon");
  assert.match(targets[0]?.url ?? "", /\/stream\/series\/tt10986410%3A1%3A1\.json$/);
  assert.deepEqual(await gateway.streams([torrentio, orion], "series", "tt10986410:1:1"), { streams: [] });

  const imported = await gateway.normalizeBrowserStreamPayload([torrentio, orion], torrentio.manifest.id, {
    streams: [{
      url: "https://1.0.0.1/ted-lasso.mp4",
      name: "[RD+] Torrentio\n1080p",
      title: "Ted.Lasso.S01E01.1080p.WEB.h264\n👤 324 💾 1.2 GB ⚙️ RARBG"
    }]
  });
  assert.equal(imported.streams.length, 1);
  assert.equal(imported.streams[0]?.kind, "direct");
  assert.equal(imported.streams[0]?.quality, "1080p");
  assert.equal(imported.streams[0]?.addonName, "Add-on de teste");
});

test("gateway.streams preserva até 300 fontes por add-on e limita a resposta em 300", async () => {
  const addons = ["a", "b", "c"].map((letra) => descriptor({
    id: `org.example.${letra}`,
    transportUrl: `https://${letra}.example/manifest.json`
  }));
  const gateway = new StremioAddonGateway({
    fetchJson: async (url) => ({
      // 320 por add-on para provar o teto defensivo; três add-ons ultrapassam o limite global.
      streams: Array.from({ length: 320 }, (_, index) => ({
        url: `https://1.1.1.1/${new URL(url).hostname}/v${index}.mp4`,
        title: `Fonte ${index}`
      }))
    })
  });
  const result = await gateway.streams(addons, "movie", "tt1");
  assert.equal(result.streams.length, 300);
  const porAddon = new Map<string, number>();
  for (const stream of result.streams) {
    porAddon.set(stream.addonId, (porAddon.get(stream.addonId) ?? 0) + 1);
  }
  for (const total of porAddon.values()) assert.ok(total <= 300);
  assert.equal([...porAddon.values()].reduce((a, b) => a + b, 0), 300);
});

test("gateway.streams mantém os demais add-ons quando um rejeita", async () => {
  const ruim = descriptor({ id: "org.example.ruim", transportUrl: "https://ruim.example/manifest.json" });
  const bom = descriptor({ id: "org.example.bom", transportUrl: "https://bom.example/manifest.json" });
  const gateway = new StremioAddonGateway({
    fetchJson: async (url) => {
      if (url.startsWith("https://ruim.example/")) {
        throw new StremioIntegrationError("UPSTREAM_UNAVAILABLE");
      }
      return { streams: [{ url: "https://1.1.1.1/unico.mp4", title: "Única fonte" }] };
    }
  });
  const result = await gateway.streams([ruim, bom], "movie", "tt9");
  assert.deepEqual(result.streams.map((stream) => stream.addonId), ["org.example.bom"]);
  // Falha total resolve com lista vazia em vez de derrubar a rota.
  assert.deepEqual((await gateway.streams([ruim], "movie", "tt9")).streams, []);
});

test("gateway.streams gera id estável (sha256 truncado) sem expor a URL no identificador", async () => {
  const addon = descriptor({ id: "org.example.hash" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({ streams: [{ url: "https://1.1.1.1/filme.mp4", title: "Fonte" }] })
  });
  const primeira = await gateway.streams([addon], "movie", "tt7");
  const segunda = await gateway.streams([addon], "movie", "tt7");
  const esperado = createHash("sha256")
    .update(`org.example.hash${String.fromCharCode(0)}https://1.1.1.1/filme.mp4`)
    .digest("hex")
    .slice(0, 32);
  assert.match(esperado, /^[0-9a-f]{32}$/);
  assert.equal(primeira.streams[0]?.id, esperado);
  assert.equal(segunda.streams[0]?.id, esperado);
});

test("gateway.streams extrai qualidade, tamanho, seeders, fonte e aviso de codec no formato real do Torrentio", async () => {
  const addon = descriptor({ id: "org.example.torrentio" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        {
          url: "https://1.1.1.1/hail-mary-en.mp4",
          name: "Torrentio\n4k HDR",
          title: "Project.Hail.Mary.2026.PROPER.HDR.2160p.WEB.h265-GRACE\n" +
            "👤 1543 💾 27.59 GB ⚙️ ThePirateBay\n🇬🇧 / 🇪🇸 / 🇩🇪"
        },
        {
          // name diz "1080p" mas title diz "2160p / 4K": name é mais confiável e deve vencer
          // na qualidade — mayNotPlay, porém, olha os dois campos e continua acusando HEVC/DV.
          url: "https://1.1.1.1/hail-mary-ru.mp4",
          name: "Torrentio\n1080p",
          title: "Проект «Конец света» / Project Hail Mary (2026) WEB-DL-HEVC 2160p | 4K | HDR10+ | Dolby Vision\n" +
            "👤 814 💾 31.34 GB ⚙️ Rutor\n🇬🇧 / 🇷🇺"
        }
      ]
    })
  });
  const result = await gateway.streams([addon], "movie", "tt-torrentio");
  assert.deepEqual(result.streams.map((stream) => ({
    url: stream.url,
    label: stream.label,
    quality: stream.quality,
    sizeLabel: stream.sizeLabel,
    seeders: stream.seeders,
    source: stream.source,
    mayNotPlay: stream.mayNotPlay
  })), [
    {
      url: "https://1.1.1.1/hail-mary-en.mp4",
      label: "Project.Hail.Mary.2026.PROPER.HDR.2160p.WEB.h265-GRACE",
      quality: "4K",
      sizeLabel: "27.59 GB",
      seeders: 1543,
      source: "ThePirateBay",
      mayNotPlay: true
    },
    {
      url: "https://1.1.1.1/hail-mary-ru.mp4",
      label: "Проект «Конец света» / Project Hail Mary (2026) WEB-DL-HEVC 2160p | 4K | HDR10+ | Dolby Vision",
      quality: "1080p",
      sizeLabel: "31.34 GB",
      seeders: 814,
      source: "Rutor",
      mayNotPlay: true
    }
  ]);
});

test("gateway.streams extrai metadados de forma resiliente em casos degenerados", async () => {
  const addon = descriptor({ id: "org.example.degenerado" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        // Sem 👤/💾/⚙️: só a qualidade dá pra reconhecer no título.
        { url: "https://1.1.1.1/sem-marcadores.mp4", title: "Filme.Sem.Metadados.1080p.WEB-DL" },
        // name sem 2ª linha (só o nome do add-on) e sem title: label cai pro fallback do name.
        { url: "https://1.1.1.1/nome-sem-segunda-linha.mp4", name: "Torrentio" },
        // title vazio: label cai pro name.
        { url: "https://1.1.1.1/title-vazio.mp4", title: "", name: "Legendado" },
        // Seeders absurdos (>1e7) são descartados, mas tamanho e fonte continuam válidos.
        {
          url: "https://1.1.1.1/seeders-absurdo.mp4",
          title: "Filme.Absurdo.720p\n👤 99999999999 💾 1.20 GB ⚙️ ExemploTracker"
        },
        // .mkv com codec compatível NÃO aciona mayNotPlay: medido com canPlayType, o Chrome
        // responde "probably" para video/x-matroska; codecs="avc1.42E01E".
        { url: "https://1.1.1.1/mkv-sem-hevc.mp4", title: "Filme.Legendado.1080p.WEB-DL.mkv" },
        // Add-on que não segue o formato Torrentio: sem emojis, sem HEVC/h265/mkv.
        { url: "https://1.1.1.1/outro-addon.mp4", title: "1917 (2019) BluRay 1080p x264 AAC-Grupo [2.1GB]" }
      ]
    })
  });
  const result = await gateway.streams([addon], "movie", "tt-degenerado");
  assert.equal(result.streams.length, 6);
  const byUrl = new Map(result.streams.map((stream) => [stream.url, stream]));

  const semMarcadores = byUrl.get("https://1.1.1.1/sem-marcadores.mp4");
  assert.equal(semMarcadores?.quality, "1080p");
  assert.equal(semMarcadores?.sizeLabel, null);
  assert.equal(semMarcadores?.seeders, null);
  assert.equal(semMarcadores?.source, null);
  assert.equal(semMarcadores?.mayNotPlay, false);
  assert.equal(semMarcadores?.label, "Filme.Sem.Metadados.1080p.WEB-DL");

  const nomeSemSegundaLinha = byUrl.get("https://1.1.1.1/nome-sem-segunda-linha.mp4");
  assert.equal(nomeSemSegundaLinha?.quality, null);
  assert.equal(nomeSemSegundaLinha?.label, "Torrentio");

  const tituloVazio = byUrl.get("https://1.1.1.1/title-vazio.mp4");
  assert.equal(tituloVazio?.label, "Legendado");
  assert.equal(tituloVazio?.quality, null);

  const seedersAbsurdo = byUrl.get("https://1.1.1.1/seeders-absurdo.mp4");
  assert.equal(seedersAbsurdo?.seeders, null);
  assert.equal(seedersAbsurdo?.sizeLabel, "1.20 GB");
  assert.equal(seedersAbsurdo?.source, "ExemploTracker");
  assert.equal(seedersAbsurdo?.quality, "720p");
  assert.equal(seedersAbsurdo?.label, "Filme.Absurdo.720p");

  const mkvSemHevc = byUrl.get("https://1.1.1.1/mkv-sem-hevc.mp4");
  assert.equal(mkvSemHevc?.mayNotPlay, false);
  assert.equal(mkvSemHevc?.quality, "1080p");

  const outroAddon = byUrl.get("https://1.1.1.1/outro-addon.mp4");
  assert.equal(outroAddon?.quality, "1080p");
  assert.equal(outroAddon?.sizeLabel, null);
  assert.equal(outroAddon?.seeders, null);
  assert.equal(outroAddon?.source, null);
  assert.equal(outroAddon?.mayNotPlay, false);
  assert.equal(outroAddon?.label, "1917 (2019) BluRay 1080p x264 AAC-Grupo [2.1GB]");
});

test("gateway.streams ordena por qualidade (4K → 1080p → 720p → 480p → SD → sem info) e depois por seeders decrescentes", async () => {
  const addon = descriptor({ id: "org.example.ordenacao" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        { url: "https://1.1.1.1/a.mp4", title: "Filme.A.480p.WEB\n👤 50 💾 700 MB ⚙️ TrackerA" },
        { url: "https://1.1.1.1/b.mp4", title: "Filme.B.2160p.WEB\n👤 10 💾 5 GB ⚙️ TrackerB" },
        { url: "https://1.1.1.1/c.mp4", title: "Filme.C.2160p.WEB\n👤 500 💾 6 GB ⚙️ TrackerC" },
        { url: "https://1.1.1.1/d.mp4", title: "Filme.D.720p.WEB\n👤 200 💾 1.4 GB ⚙️ TrackerD" },
        { url: "https://1.1.1.1/e.mp4", title: "Filme.E.SemQualidade\n👤 999 💾 2 GB ⚙️ TrackerE" },
        { url: "https://1.1.1.1/f.mp4", title: "Filme.F.SemNada" },
        { url: "https://1.1.1.1/g.mp4", title: "Filme.G.1080p.WEB\n👤 5 💾 1 GB ⚙️ TrackerG" }
      ]
    })
  });
  const result = await gateway.streams([addon], "movie", "tt-ordenacao");
  assert.deepEqual(result.streams.map((stream) => stream.url), [
    "https://1.1.1.1/c.mp4", // 4K, 500 seeders
    "https://1.1.1.1/b.mp4", // 4K, 10 seeders
    "https://1.1.1.1/g.mp4", // 1080p
    "https://1.1.1.1/d.mp4", // 720p
    "https://1.1.1.1/a.mp4", // 480p
    "https://1.1.1.1/e.mp4", // sem qualidade, mas com seeders
    "https://1.1.1.1/f.mp4" // sem qualidade e sem seeders: por último
  ]);
  assert.deepEqual(result.streams.map((stream) => stream.quality), [
    "4K", "4K", "1080p", "720p", "480p", null, null
  ]);
});

test("gateway.catalog descarta metas inválidos, limpa HTML e anula poster fora de HTTPS público", async () => {
  const addon = descriptor({
    id: "org.example.catalogo",
    catalogs: [{ id: "populares", type: "movie", name: "<b>Populares</b>" }]
  });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      metas: [
        null,
        42,
        "texto",
        { name: "Sem id" },
        { id: "tt-sem-nome" },
        { id: `tt${controle}controle`, name: "Id com caractere de controle" },
        {
          id: "tt-ok",
          name: "<i>Nome</i> limpo",
          type: "movie",
          poster: "http://images.example/capa.jpg",
          background: "https://10.0.0.1/fundo.jpg",
          description: `<p>Sinopse</p>${controle}boa`,
          releaseInfo: "2026"
        },
        { id: "tt-sem-tipo", name: "Sem tipo" }
      ]
    })
  });
  const result = await gateway.catalog([addon], "org.example.catalogo", "movie", "populares");
  assert.equal(result.name, "Populares");
  assert.deepEqual(result.items, [
    {
      id: "tt-ok",
      type: "movie",
      name: "Nome limpo",
      poster: null,
      background: null,
      description: "Sinopse boa",
      releaseInfo: "2026"
    },
    {
      id: "tt-sem-tipo",
      type: "movie",
      name: "Sem tipo",
      poster: null,
      background: null,
      description: null,
      releaseInfo: null
    }
  ]);
});

test("gateway.catalog corta em 100 itens e rejeita corpo sem metas", async () => {
  const addon = descriptor({
    id: "org.example.catalogo",
    catalogs: [{ id: "populares", type: "movie" }]
  });
  const cheio = new StremioAddonGateway({
    fetchJson: async () => ({
      metas: Array.from({ length: 150 }, (_, index) => ({ id: `tt${index}`, name: `Filme ${index}` }))
    })
  });
  const result = await cheio.catalog([addon], "org.example.catalogo", "movie", "populares");
  assert.equal(result.items.length, 100);

  const semMetas = new StremioAddonGateway({ fetchJson: async () => ({}) });
  await assert.rejects(
    semMetas.catalog([addon], "org.example.catalogo", "movie", "populares"),
    (error: unknown) =>
      error instanceof StremioIntegrationError &&
      error.code === "INVALID_RESPONSE" &&
      // Mensagem genérica: não pode vazar host nem URL do add-on.
      !error.message.includes("example")
  );
});

test("gateway reutiliza metadados recentes e evita chamadas repetidas ao add-on", async () => {
  const addon = descriptor({
    id: "org.example.cache",
    catalogs: [{ id: "populares", type: "movie", name: "Populares" }]
  });
  let calls = 0;
  const gateway = new StremioAddonGateway({
    fetchJson: async () => {
      calls += 1;
      return { metas: [{ id: "tt-cache", name: "Filme em cache" }] };
    }
  });

  const [first, second] = await Promise.all([
    gateway.catalog([addon], addon.manifest.id, "movie", "populares"),
    gateway.catalog([addon], addon.manifest.id, "movie", "populares")
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(second, first);
});

test("gateway.search usa somente catálogos com extra search e deduplica títulos", async () => {
  const addon = descriptor({
    id: "org.example.busca",
    catalogs: [
      { id: "catalogo-filmes", type: "movie", name: "Filmes" },
      { id: "sem-busca", type: "series", name: "Séries" }
    ],
    transportUrl: "https://busca.example/manifest.json"
  });
  (addon.manifest.catalogs[0] as Record<string, unknown>).extra = [{ name: "search", isRequired: true }];
  const chamadas: string[] = [];
  const gateway = new StremioAddonGateway({ fetchJson: async (url) => {
    chamadas.push(url);
    return { metas: [
      { id: "tt123", type: "movie", name: "Projeto Teste", poster: "https://1.1.1.1/poster.jpg" },
      { id: "tt123", type: "movie", name: "Projeto Teste duplicado" },
      { name: "Sem id" }
    ] };
  }});
  const { items: result, complete } = await gateway.search([addon], "Projeto Teste");
  assert.deepEqual(chamadas, ["https://busca.example/catalog/movie/catalogo-filmes/search=Projeto%20Teste.json"]);
  assert.equal(complete, true);
  assert.equal(result.length, 1);
  assert.equal(result[0].addonId, "org.example.busca");
  assert.equal(result[0].id, "tt123");
});

test("gateway.meta corta videos em 2000 e descarta entradas sem id", async () => {
  const addon = descriptor({ id: "org.example.meta" });
  const cheio = new StremioAddonGateway({
    fetchJson: async () => ({
      meta: {
        id: "tt2",
        name: "Série longa",
        type: "series",
        videos: Array.from({ length: 2_100 }, (_, index) => ({ id: `tt2:${index}`, title: `Ep ${index}` }))
      }
    })
  });
  assert.equal((await cheio.meta([addon], "org.example.meta", "series", "tt2")).videos.length, 2_000);

  const misto = new StremioAddonGateway({
    fetchJson: async () => ({
      meta: {
        id: "tt2",
        name: "Série curta",
        type: "series",
        videos: [
          { title: "Sem id" },
          null,
          "texto",
          {
            id: "tt2:1:1", title: "<b>Piloto</b>", season: 1, episode: 1, released: "2026-01-01",
            thumbnail: "https://episodes.metahub.space/tt2/1/1/w780.jpg"
          },
          // O Cinemeta manda `name`, nunca `title`. Ler só `title` fazia TODO episódio cair no
          // fallback e a lista inteira exibir o nome da série repetido.
          { id: "tt2:1:2", name: "A Estrada do Rei", season: 1, episode: 2, thumbnail: "http://inseguro/x.jpg" },
          { id: "tt2:9", season: -1, episode: 2.5, released: "data inválida" }
        ]
      }
    })
  });
  const serie = await misto.meta([addon], "org.example.meta", "series", "tt2");
  assert.deepEqual(serie.videos, [
    {
      id: "tt2:1:1", title: "Piloto", season: 1, episode: 1,
      released: "2026-01-01T00:00:00.000Z",
      thumbnail: "https://episodes.metahub.space/tt2/1/1/w780.jpg"
    },
    // Miniatura em http:// é descartada como qualquer outra imagem de add-on: a página é https.
    { id: "tt2:1:2", title: "A Estrada do Rei", season: 1, episode: 2, released: null, thumbnail: null },
    { id: "tt2:9", title: "Série curta", season: null, episode: null, released: null, thumbnail: null }
  ]);
});

test("gateway.meta cria vídeo sintético para filme sem videos", async () => {
  const addon = descriptor({ id: "org.example.meta" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({ meta: { id: "tt3", name: "Filme sem episódios", type: "movie" } })
  });
  const filme = await gateway.meta([addon], "org.example.meta", "movie", "tt3");
  assert.deepEqual(filme.videos, [
    { id: "tt3", title: "Filme sem episódios", season: null, episode: null, released: null, thumbnail: null }
  ]);
});

test("gateway.meta usa outro add-on quando o preferido não atende o resource", async () => {
  const preferido = descriptor({
    id: "org.example.so-catalogo",
    resources: ["catalog"],
    transportUrl: "https://preferido.example/manifest.json"
  });
  const reserva = descriptor({
    id: "org.example.reserva",
    idPrefixes: ["tt"],
    transportUrl: "https://reserva.example/manifest.json"
  });
  const chamadas: string[] = [];
  const gateway = new StremioAddonGateway({
    fetchJson: async (url) => {
      chamadas.push(url);
      return { meta: { id: "tt5", name: "Resgatado", type: "movie" } };
    }
  });
  const result = await gateway.meta([preferido, reserva], "org.example.so-catalogo", "movie", "tt5");
  assert.equal(result.name, "Resgatado");
  assert.deepEqual(chamadas, ["https://reserva.example/meta/movie/tt5.json"]);
});

test("gateway percent-encoda tentativa de traversal no id antes de chamar o add-on", async () => {
  const addon = descriptor({
    id: "org.example.travessia",
    transportUrl: "https://travessia.example/sub/manifest.json"
  });
  const chamadas: string[] = [];
  const gateway = new StremioAddonGateway({
    fetchJson: async (url) => {
      chamadas.push(url);
      return { streams: [] };
    }
  });
  await gateway.streams([addon], "movie", "../../x");
  assert.deepEqual(chamadas, ["https://travessia.example/sub/stream/movie/..%2F..%2Fx.json"]);
  const chamada = new URL(chamadas[0]);
  assert.equal(chamada.href.includes("../"), false);
  assert.ok(chamada.pathname.startsWith("/sub/stream/movie/"));
});

test("gateway.listCatalogs expõe só catálogos movie/series; add-on com catálogos 'tv'/'other' continua utilizável para stream/meta", async () => {
  const addon = descriptor({
    id: "org.example.misto",
    idPrefixes: ["tt"],
    catalogs: [
      { id: "populares-filmes", type: "movie", name: "Populares" },
      { id: "populares-series", type: "series" },
      { id: "canais-ao-vivo", type: "tv" },
      { id: "diversos", type: "other" }
    ]
  });

  // Só os catálogos navegáveis (movie/series) aparecem; "tv" e "other" ficam de fora da lista,
  // mas o add-on inteiro não é descartado — o descriptor mantém os quatro catálogos.
  const catalogs = new StremioAddonGateway().listCatalogs([addon]);
  assert.deepEqual(catalogs, [
    { addonId: "org.example.misto", catalogId: "populares-filmes", type: "movie", name: "Populares" },
    { addonId: "org.example.misto", catalogId: "populares-series", type: "series", name: "Add-on de teste" }
  ]);
  assert.equal(addon.manifest.catalogs.length, 4);

  // O mesmo add-on continua respondendo stream/meta normalmente: catalogs[].type não interfere
  // em matchesResource.
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({ streams: [{ url: "https://1.1.1.1/ainda-funciona.mp4", title: "Ainda funciona" }] })
  });
  const streamsResult = await gateway.streams([addon], "movie", "tt123");
  assert.deepEqual(streamsResult.streams.map((stream) => stream.url), ["https://1.1.1.1/ainda-funciona.mp4"]);

  const metaGateway = new StremioAddonGateway({
    fetchJson: async () => ({ meta: { id: "tt123", name: "Ainda funciona", type: "movie" } })
  });
  const metaResult = await metaGateway.meta([addon], "org.example.misto", "movie", "tt123");
  assert.equal(metaResult.name, "Ainda funciona");
});

test("gateway.streams extrai idioma de áudio das bandeiras; release sem marcação fica com lista vazia", async () => {
  const addon = descriptor({ id: "org.example.torrentio" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        {
          // Formato real observado: bandeiras em linha própria, separadas por " / ".
          url: "https://1.1.1.1/dark-knight.mp4",
          name: "Torrentio\n1080p",
          title: "The Dark Knight 2008 Bluray IMAX 2160p EN/ITA/FRE\n👤 40 💾 20 GB ⚙️ 1337x\n🇬🇧 / 🇮🇹 / 🇫🇷"
        },
        {
          // Metade dos releases reais não traz bandeira nenhuma: é o áudio original do conteúdo.
          url: "https://1.1.1.1/anatomie.mp4",
          name: "Torrentio\n1080p",
          title: "Anatomie.d.une.chute.2023.1080p.BluRay.Remux\n👤 12 💾 30 GB ⚙️ 1337x"
        },
        {
          // Português do Brasil e de Portugal colapsam no mesmo código de idioma.
          url: "https://1.1.1.1/dublado.mp4",
          name: "Torrentio\n1080p",
          title: "Filme.Dublado.1080p\n👤 9 💾 2 GB ⚙️ Comando\n🇧🇷 / 🇵🇹 / 🇧🇷"
        },
        {
          // Bandeira desconhecida na tabela país→idioma não pode virar entrada inválida.
          url: "https://1.1.1.1/exotico.mp4",
          name: "Torrentio\n1080p",
          title: "Exotico.1080p\n👤 3 💾 1 GB ⚙️ X\n🇦🇶 / 🇬🇧"
        }
      ]
    })
  });
  const result = await gateway.streams([addon], "movie", "tt-idiomas");
  assert.deepEqual(result.streams.map((stream) => stream.audioLanguages), [
    ["en", "it", "fr"],
    [],
    ["pt"],
    ["en"]
  ]);
});

test("gateway.streams separa legenda de áudio e marca dublagem anunciada só no nome do arquivo", async () => {
  const addon = descriptor({ id: "org.example.torrentio" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        {
          // "Multi Subs": as bandeiras são LEGENDA. O áudio é só o original, não en+it.
          url: "https://1.1.1.1/multisub.mp4",
          name: "Torrentio\n1080p",
          title: "Breaking Bad S01 - 1080p ENG-ITA Multisub x264\n👤 56 💾 4 GB ⚙️ TPB\nMulti Subs / 🇬🇧 / 🇮🇹"
        },
        {
          // "Dual Audio": aí sim as bandeiras são áudio, e o release é dublado.
          url: "https://1.1.1.1/dual.mp4",
          name: "Torrentio\n1080p",
          title: "Breaking Bad 1ª Temporada [4k] BLUDV\n👤 30 💾 9 GB ⚙️ BluDV\nDual Audio / 🇬🇧 / 🇵🇹"
        },
        {
          // Caso real que passou batido: nenhuma bandeira, dublagem só no nome do arquivo.
          url: "https://1.1.1.1/dual-lat.mp4",
          name: "Torrentio\n1080p",
          title: "Breaking.Bad.S01E01.2008.1080P-Dual-Lat\n👤 2 💾 1.15 GB ⚙️ Cinecalidad"
        },
        {
          // Erai-raws escreve "[Multiple Subtitle]": são legendas, o áudio é o japonês original.
          url: "https://1.1.1.1/multiple-subtitle.mkv",
          name: "Brazuca Torrents\n1080p",
          title: "[Erai-raws] One Piece - 1106 [1080p][Multiple Subtitle][A0719DEC].mkv"
        },
        {
          // Legenda múltipla no nome não pode ser confundida com dublagem.
          url: "https://1.1.1.1/so-legenda.mp4",
          name: "Torrentio\n1080p",
          title: "Breaking Bad S01-S05 1080p NF WEB-DL Multisub\n👤 20 💾 5 GB ⚙️ NF"
        }
      ]
    })
  });
  const result = await gateway.streams([addon], "series", "tt-dub:1:1");
  // Chaveado por URL de propósito: gateway.streams ordena por qualidade e seeders, então a
  // ordem de saída não é a de entrada e um deepEqual posicional testaria a ordenação, não a
  // extração de idioma.
  const porUrl = new Map(result.streams.map((stream) => [
    stream.url,
    { audio: stream.audioLanguages, dubbed: stream.dubbed }
  ]));
  assert.deepEqual(porUrl.get("https://1.1.1.1/multisub.mp4"), { audio: [], dubbed: false });
  assert.deepEqual(porUrl.get("https://1.1.1.1/dual.mp4"), { audio: ["en", "pt"], dubbed: true });
  assert.deepEqual(porUrl.get("https://1.1.1.1/dual-lat.mp4"), { audio: [], dubbed: true });
  assert.deepEqual(porUrl.get("https://1.1.1.1/so-legenda.mp4"), { audio: [], dubbed: false });
  assert.deepEqual(porUrl.get("https://1.1.1.1/multiple-subtitle.mkv"), { audio: [], dubbed: false });
});

test("gateway.streams identifica legendas anunciadas sem confundi-las com áudio", async () => {
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({ streams: [
      {
        url: "https://1.1.1.1/bandeiras.mp4", name: "1080p",
        title: "Release\nMulti Subs / 🇧🇷 / 🇬🇧"
      },
      {
        url: "https://1.1.1.1/inline.mp4", name: "1080p",
        subtitles: [{ lang: "pob", url: "https://legendas.example/br.srt" }]
      },
      { url: "https://1.1.1.1/sem-dados.mp4", name: "1080p" }
    ] })
  });
  const result = await gateway.streams([descriptor({ id: "org.example.stream" })], "movie", "tt1234567");
  const byUrl = new Map(result.streams.map((stream) => [stream.url, stream]));

  assert.deepEqual(byUrl.get("https://1.1.1.1/bandeiras.mp4")?.subtitleLanguages, ["pt-BR", "en"]);
  assert.deepEqual(byUrl.get("https://1.1.1.1/bandeiras.mp4")?.audioLanguages, []);
  assert.deepEqual(byUrl.get("https://1.1.1.1/inline.mp4")?.subtitleLanguages, ["pt-BR"]);
  assert.deepEqual(byUrl.get("https://1.1.1.1/sem-dados.mp4")?.subtitleLanguages, []);
});

test("gateway.subtitles mostra idiomas disponíveis sem perder opções por código inválido", async () => {
  const addon = descriptor({ id: "org.example.subs", resources: ["subtitles"] });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      subtitles: [
        { url: "https://1.1.1.1/invalida.vtt", lang: "aa-aaa", label: "Código inválido" },
        { url: "https://1.1.1.1/pob.vtt", lang: "pob", label: "Português (Brasil)" },
        { url: "https://1.1.1.1/por.vtt", lang: "por", label: "Português" },
        { url: "https://1.1.1.1/ptbr.vtt", lang: "pt-BR", label: "PT-BR" },
        { url: "https://1.1.1.1/eng.vtt", lang: "eng", label: "English" },
        { url: "https://1.1.1.1/en.vtt", lang: "en", label: "English SDH" },
        { url: "https://1.1.1.1/release.vtt", lang: "pob", label: "WEB-DL 1080p AMZN" },
        { url: "https://1.1.1.1/spa.vtt", lang: "spa", label: "Español" },
        { url: "https://1.1.1.1/rus.vtt", lang: "rus", label: "Русский" },
        { url: "https://1.1.1.1/ita.vtt", lang: "ita", label: "Italiano" },
        // lang ausente: cai no rótulo como segunda chance.
        { url: "https://1.1.1.1/sem-lang.vtt", label: "Legenda em Português" },
        { url: "https://1.1.1.1/sem-lang-jp.vtt", label: "Japanese subtitles" }
      ]
    })
  });
  const result = await gateway.subtitles([addon], "movie", "tt-legendas");
  // Rótulo pelo NOME do idioma, não pelo id numérico do add-on: o OpenSubtitles v3 manda
  // { id, url, lang } sem label, e a lista aparecia como "3265167 · OpenSubtitles v3".
  // Repetidos do mesmo idioma são numerados para não ficarem indistinguíveis.
  assert.deepEqual(result.map((subtitle) => subtitle.label), [
    "Português (Brasil)",
    "Português",
    "Português (Brasil) 2",
    "Inglês",
    "Inglês 2",
    "Português (Brasil) 3",
    "Espanhol",
    "Russo",
    "Italiano",
    "Legenda em Português"
  ]);
  assert.deepEqual(result.map((subtitle) => subtitle.url), [
    "https://1.1.1.1/pob.vtt",
    "https://1.1.1.1/por.vtt",
    "https://1.1.1.1/ptbr.vtt",
    "https://1.1.1.1/eng.vtt",
    "https://1.1.1.1/en.vtt",
    "https://1.1.1.1/release.vtt",
    "https://1.1.1.1/spa.vtt",
    "https://1.1.1.1/rus.vtt",
    "https://1.1.1.1/ita.vtt",
    "https://1.1.1.1/sem-lang.vtt"
  ]);
  assert.equal(result.find((subtitle) => subtitle.url.endsWith("release.vtt"))?.details, "WEB-DL 1080p AMZN");
});

// Medido na conta real: o Torrentio RD devolve 97 fontes para "Oppenheimer" e TODAS marcadas
// [RD+]. Sem ler a marca, o Cebola escolhia pelo nome do arquivo e só descobria depois que o
// Real-Debrid teria que baixar aquilo — que é a espera no "Preparando…". Três estados, porque
// "o add-on não avisa" (ThePirateBay+, Brazuca, Orion) é diferente de "avisou que falta baixar".
test("gateway.streams lê a etiqueta de cache do debrid em readyNow", async () => {
  const addon = descriptor({ id: "org.example.torrentio" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        { url: "https://1.1.1.1/pronta.mp4", name: "[RD+] Torrentio\n1080p", title: "Filme.1080p.x264\n👤 300" },
        { url: "https://1.1.1.1/baixar.mp4", name: "[RD download] Torrentio\n1080p", title: "Filme.Outro.1080p.x264\n👤 300" },
        { url: "https://1.1.1.1/sem-aviso.mp4", name: "ThePirateBay+\n1080p", title: "Filme.Terceiro.1080p.x264\n👤 300" }
      ]
    })
  });
  const porUrl = new Map((await gateway.streams([addon], "movie", "tt-cache"))
    .streams.map((stream) => [stream.url, stream]));
  assert.equal(porUrl.get("https://1.1.1.1/pronta.mp4")?.readyNow, true);
  assert.equal(porUrl.get("https://1.1.1.1/baixar.mp4")?.readyNow, false);
  assert.equal(porUrl.get("https://1.1.1.1/sem-aviso.mp4")?.readyNow, null);
});

// Ordenação: dentro da mesma qualidade, o que abre agora vem antes. Quem não avisa fica no meio
// — continua disponível, mas nunca ganha de quem confirmou que está pronto.
test("gateway.streams ordena pronto antes de quem não avisa, e ambos antes do que falta baixar", async () => {
  const addon = descriptor({ id: "org.example.torrentio" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        { url: "https://1.1.1.1/c.mp4", name: "[RD download] Torrentio\n1080p", title: "C.1080p.x264\n👤 900" },
        { url: "https://1.1.1.1/b.mp4", name: "Outro\n1080p", title: "B.1080p.x264\n👤 800" },
        { url: "https://1.1.1.1/a.mp4", name: "[RD+] Torrentio\n1080p", title: "A.1080p.x264\n👤 1" }
      ]
    })
  });
  const result = await gateway.streams([addon], "movie", "tt-ordem");
  assert.deepEqual(result.streams.map((stream) => stream.url), [
    "https://1.1.1.1/a.mp4",
    "https://1.1.1.1/b.mp4",
    "https://1.1.1.1/c.mp4"
  ]);
});

// A ordem manual precisa concordar com o autoplay (`rankAutomaticSources`, no app), que também
// coloca "pronto agora" antes de resolução: uma fonte em qualidade menor mas já em cache do
// debrid abre na hora, e uma em 4K que ainda precisa baixar não toca — não é "melhor".
test("gateway.streams ordena pronto agora ANTES de qualidade — 720p pronto vence 4K que precisa baixar", async () => {
  const addon = descriptor({ id: "org.example.prontoversusqualidade" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        { url: "https://1.1.1.1/4k-baixar.mp4", name: "[RD download] Torrentio\n2160p", title: "Filme.2160p.x264\n👤 900" },
        { url: "https://1.1.1.1/720p-pronto.mp4", name: "[RD+] Torrentio\n720p", title: "Filme.720p.x264\n👤 1" }
      ]
    })
  });
  const result = await gateway.streams([addon], "movie", "tt-pronto-vs-qualidade");
  assert.deepEqual(result.streams.map((stream) => stream.url), [
    "https://1.1.1.1/720p-pronto.mp4",
    "https://1.1.1.1/4k-baixar.mp4"
  ]);
});

// Medido com canPlayType no Chrome deste Linux: 'video/x-matroska; codecs="avc1.42E01E"'
// responde "probably". O .mkv tocava, e mesmo assim acendia o aviso em 29% das fontes.
test("gateway.streams não acusa .mkv sozinho como incompatível", async () => {
  const addon = descriptor({ id: "org.example.mkv" });
  const gateway = new StremioAddonGateway({
    fetchJson: async () => ({
      streams: [
        { url: "https://1.1.1.1/limpo.mp4", name: "Torrentio\n1080p", title: "Filme.1080p.BluRay.x264.AAC.mkv\n👤 400" },
        { url: "https://1.1.1.1/hevc.mp4", name: "Torrentio\n1080p", title: "Filme.1080p.BluRay.x265.mkv\n👤 400" }
      ]
    })
  });
  const porUrl = new Map((await gateway.streams([addon], "movie", "tt-mkv"))
    .streams.map((stream) => [stream.url, stream]));
  assert.equal(porUrl.get("https://1.1.1.1/limpo.mp4")?.mayNotPlay, false);
  assert.equal(porUrl.get("https://1.1.1.1/hevc.mp4")?.mayNotPlay, true);
});

test("fontes do servidor e importadas preservam trackers e índice sem resolver o torrent", async () => {
  const addon = descriptor();
  const payload = { streams: [{ infoHash: "a".repeat(40), fileIdx: 7,
    sources: ["tracker:udp://tracker.example.org:6969/announce", "tracker:http://127.0.0.1/a"],
    behaviorHints: { filename: "episode.mkv" } }] };
  const gateway = new StremioAddonGateway({ fetchJson: async () => payload });
  for (const result of [await gateway.streams([addon], "series", "tt123:1:8"),
    await gateway.normalizeBrowserStreamPayload([addon], addon.manifest.id, payload)]) {
    const stream = result.streams[0];
    assert.equal(stream?.kind, "torrent");
    if (stream?.kind !== "torrent") throw new Error("torrent ausente");
    assert.deepEqual(stream.trackers, ["udp://tracker.example.org:6969/announce"]);
    assert.equal(stream.fileIdx, 7);
    assert.equal(stream.filename, "episode.mkv");
    assert.equal(stream.url, null);
  }
});

test("gateway.streams não espera o add-on que nunca responde depois que outro trouxe fontes", async () => {
  const travado = descriptor({ id: "org.example.travado", transportUrl: "https://travado.example/manifest.json" });
  const bom = descriptor({ id: "org.example.bom", transportUrl: "https://bom.example/manifest.json" });
  const gateway = new StremioAddonGateway({
    fetchJson: async (url) => url.startsWith("https://travado.example/")
      ? new Promise(() => undefined)
      : { streams: [{ url: "https://1.1.1.1/rapida.mp4", title: "Rápida" }] }
  });
  const inicio = Date.now();
  const result = await gateway.streams([travado, bom], "movie", "tt7", 50);
  assert.ok(Date.now() - inicio < 1_000);
  assert.deepEqual(result.streams.map((stream) => stream.addonId), ["org.example.bom"]);
});
