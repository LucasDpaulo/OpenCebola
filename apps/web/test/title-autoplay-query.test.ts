import assert from "node:assert/strict";
import test from "node:test";
import { consumedAutoplayUrl } from "../app/titulo/autoplay-query.js";

test("fechar o player consome play=1 sem perder título, episódio ou outros parâmetros", () => {
  const href = "https://cebola.example/titulo/index.html?addon=editorial.tmdb&type=series&id=tt0388629&video=tt0388629%3A21%3A194&play=1&source=continue#episodios";
  const consumed = consumedAutoplayUrl(href);
  assert.equal(consumed, "/titulo/index.html?addon=editorial.tmdb&type=series&id=tt0388629&video=tt0388629%3A21%3A194&source=continue#episodios");
  assert.equal(consumedAutoplayUrl(`https://cebola.example${consumed}`), null);
});

test("fechar o player sem autoplay preserva a URL", () => {
  assert.equal(consumedAutoplayUrl("https://cebola.example/titulo/?addon=a&play=0"), null);
  assert.equal(consumedAutoplayUrl("https://cebola.example/titulo/?addon=a"), null);
});
