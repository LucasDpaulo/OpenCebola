import assert from "node:assert/strict";
import test from "node:test";
import { continueEntries, metadataAddonForMedia } from "../app/continue-items.js";

const episode = (videoId: string, updatedAt: string, completed = false, mediaId = "tmdb:37854") =>
  ({ mediaType: "series" as const, mediaId, videoId, updatedAt, completed });

test("uma série aberta pelo TMDB e pelo IMDb aparece uma vez em Continuar", () => {
  const items = [
    episode("tt0388629:21:153", "2026-09-23T12:00:00.000Z"),
    episode("tt0388629:21:159", "2026-09-23T13:00:00.000Z", false, "tt0388629")
  ];
  assert.deepEqual(continueEntries(items), [{ item: items[1], next: false }]);
});

test("duas séries diferentes continuam separadas e cada filme usa seu vídeo", () => {
  const items = [
    episode("tt0388629:21:153", "2026-09-23T12:00:00.000Z", false, "tt0388629"),
    episode("tt0903747:1:1", "2026-09-23T13:00:00.000Z", false, "tt0903747"),
    { mediaType: "movie" as const, mediaId: "tmdb:1", videoId: "tt0123456", updatedAt: "2026-09-23T14:00:00.000Z", completed: false }
  ];
  assert.equal(continueEntries(items).length, 3);
});

test("episódio terminado por último leva ao próximo, não a um antigo pela metade", () => {
  const items = [
    episode("tt0388629:22:1", "2026-10-12T00:47:00.000Z"),
    episode("tt0388629:22:6", "2026-10-12T16:00:00.000Z", true),
    episode("tt0388629:22:5", "2026-10-12T15:33:00.000Z")
  ];
  assert.deepEqual(continueEntries(items), [{ item: items[1], next: true }]);
});

test("gravação mais recente pela metade vence um episódio terminado antes", () => {
  const items = [
    episode("tt0388629:22:4", "2026-10-12T03:00:00.000Z", true),
    episode("tt0388629:22:5", "2026-10-12T15:33:00.000Z")
  ];
  assert.deepEqual(continueEntries(items), [{ item: items[1], next: false }]);
});

test("série removida de Continuar (tudo concluído) não volta como próximo episódio", () => {
  const items = [
    episode("tt0388629:22:5", "2026-10-12T15:33:00.000Z", true),
    episode("tt0388629:22:6", "2026-10-12T15:33:01.000Z", true)
  ];
  assert.deepEqual(continueEntries(items), []);
});

test("filme terminado sai de Continuar", () => {
  const movie = { mediaType: "movie" as const, mediaId: "tt13238346", videoId: "tt13238346", updatedAt: "2026-10-12T03:15:00.000Z", completed: true };
  assert.deepEqual(continueEntries([movie]), []);
});

test("progresso editorial legado abre pelo TMDB mesmo com addon de busca salvo", () => {
  assert.equal(metadataAddonForMedia("com.stremio.cinemeta", "tmdb:37854"), "editorial.tmdb");
});

test("metadados de títulos IMDb continuam usando seu addon original", () => {
  assert.equal(metadataAddonForMedia("com.stremio.cinemeta", "tt0388629"), "com.stremio.cinemeta");
});

test("oculto sai de Continuar sem precisar concluir o episódio", () => {
  const hidden = { ...episode("tt0388629:1:1", "2026-10-15T12:00:00Z"), hiddenFromContinue: true };
  assert.deepEqual(continueEntries([hidden]), []);
  assert.deepEqual(continueEntries([{ ...hidden, hiddenFromContinue: false }]), [
    { item: { ...hidden, hiddenFromContinue: false }, next: false }
  ]);
});
