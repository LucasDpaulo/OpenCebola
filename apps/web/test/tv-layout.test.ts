import assert from "node:assert/strict";
import test from "node:test";
import { resolveTvLayout, isTvPreviewBuild, tvCardBackdropUrl, tvLogoUrl, tvPosterUrl } from "../app/tv/tv-layout.js";

test("?tv=1 liga e manda gravar a preferência, mesmo fora da TV", () => {
  const result = resolveTvLayout({ isTv: false, queryValue: "1", stored: null });
  assert.deepEqual(result, { enabled: true, store: "on" });
});

test("?tv=1 vence o que já estava gravado como desligado", () => {
  const result = resolveTvLayout({ isTv: false, queryValue: "1", stored: "off" });
  assert.deepEqual(result, { enabled: true, store: "on" });
});

test("?tv=0 desliga e manda gravar a preferência, mesmo na TV", () => {
  const result = resolveTvLayout({ isTv: true, queryValue: "0", stored: null });
  assert.deepEqual(result, { enabled: false, store: "off" });
});

test("?tv=0 vence o que já estava gravado como ligado", () => {
  const result = resolveTvLayout({ isTv: true, queryValue: "0", stored: "on" });
  assert.deepEqual(result, { enabled: false, store: "off" });
});

test("sem query, preferência gravada 'on' liga sem regravar nada", () => {
  const result = resolveTvLayout({ isTv: false, queryValue: null, stored: "on" });
  assert.deepEqual(result, { enabled: true, store: null });
});

test("sem query, preferência gravada 'off' desliga sem regravar nada", () => {
  const result = resolveTvLayout({ isTv: true, queryValue: null, stored: "off" });
  assert.deepEqual(result, { enabled: false, store: null });
});

test("sem query e sem preferência gravada, decide pelo runtime (TV)", () => {
  const result = resolveTvLayout({ isTv: true, queryValue: null, stored: null });
  assert.deepEqual(result, { enabled: true, store: null });
});

test("sem query e sem preferência gravada, decide pelo runtime (PC/celular)", () => {
  const result = resolveTvLayout({ isTv: false, queryValue: null, stored: null });
  assert.deepEqual(result, { enabled: false, store: null });
});

test("valor de query diferente de '1'/'0' é ignorado como se não houvesse query", () => {
  const result = resolveTvLayout({ isTv: true, queryValue: "sim", stored: "off" });
  assert.deepEqual(result, { enabled: false, store: null });
});

test("isTvPreviewBuild lê a variável de build da prévia de TV (AppImage de teste no PC)", () => {
  const original = process.env.NEXT_PUBLIC_CEBOLA_TV_PREVIEW;
  try {
    process.env.NEXT_PUBLIC_CEBOLA_TV_PREVIEW = "1";
    assert.equal(isTvPreviewBuild(), true);

    process.env.NEXT_PUBLIC_CEBOLA_TV_PREVIEW = "0";
    assert.equal(isTvPreviewBuild(), false);

    delete process.env.NEXT_PUBLIC_CEBOLA_TV_PREVIEW;
    assert.equal(isTvPreviewBuild(), false);
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_CEBOLA_TV_PREVIEW;
    else process.env.NEXT_PUBLIC_CEBOLA_TV_PREVIEW = original;
  }
});

test("backdrop do card de TV troca a original do TMDB pela w780", () => {
  assert.equal(
    tvCardBackdropUrl("https://image.tmdb.org/t/p/original/abc.jpg"),
    "https://image.tmdb.org/t/p/w780/abc.jpg"
  );
});

test("backdrop do card de TV encolhe w1280 do TMDB e o background grande do metahub", () => {
  assert.equal(tvCardBackdropUrl("https://image.tmdb.org/t/p/w1280/abc.jpg"), "https://image.tmdb.org/t/p/w780/abc.jpg");
  assert.equal(
    tvCardBackdropUrl("https://images.metahub.space/background/medium/tt1/img"),
    "https://images.metahub.space/background/small/tt1/img"
  );
  assert.equal(tvCardBackdropUrl("https://image.tmdb.org/t/p/w300/abc.jpg"), "https://image.tmdb.org/t/p/w300/abc.jpg");
});

test("pôster de TV pede w185 do TMDB e small do metahub", () => {
  assert.equal(tvPosterUrl("https://image.tmdb.org/t/p/w500/p.jpg"), "https://image.tmdb.org/t/p/w185/p.jpg");
  assert.equal(tvPosterUrl("https://image.tmdb.org/t/p/w342/p.jpg"), "https://image.tmdb.org/t/p/w185/p.jpg");
  assert.equal(tvPosterUrl("https://image.tmdb.org/t/p/w92/p.jpg"), "https://image.tmdb.org/t/p/w92/p.jpg");
  assert.equal(tvPosterUrl("https://images.metahub.space/poster/medium/tt1/img"), "https://images.metahub.space/poster/small/tt1/img");
  assert.equal(tvPosterUrl("https://example.com/p.jpg"), "https://example.com/p.jpg");
});

test("logo de serviço na TV pede w92 do TMDB", () => {
  assert.equal(tvLogoUrl("https://image.tmdb.org/t/p/w185/l.png"), "https://image.tmdb.org/t/p/w92/l.png");
  assert.equal(tvLogoUrl("https://image.tmdb.org/t/p/w45/l.png"), "https://image.tmdb.org/t/p/w45/l.png");
});
