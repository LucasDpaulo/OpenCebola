import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { decodeSubtitleText } from "../src/stremio/safe-http.js";

test("legenda aceita texto simples e arquivo gzip usado pelo OpenSubtitles", () => {
  const subtitle = "1\n00:00:01,000 --> 00:00:03,000\nOlá, mundo!\n";
  assert.equal(decodeSubtitleText(Buffer.from(subtitle)), subtitle);
  assert.equal(decodeSubtitleText(gzipSync(Buffer.from(subtitle))), subtitle);
});

test("legenda recusa conteúdo binário inválido", () => {
  assert.throws(() => decodeSubtitleText(Buffer.from([0, 1, 2, 3])));
});

test("legenda em Windows-1252 não vira '�': acentos preservados", () => {
  const cp1252 = Buffer.from([0x4c, 0x65, 0x76, 0x65, 0x2d, 0x6d, 0x65, 0x20, 0xe0, 0x20, 0x41, 0x6d, 0xe9, 0x72, 0x69, 0x63, 0x61]);
  assert.equal(decodeSubtitleText(cp1252), "Leve-me à América");
});

test("legenda UTF-8 continua igual, com ou sem BOM", () => {
  assert.equal(decodeSubtitleText(Buffer.from("Ação é você", "utf8")), "Ação é você");
  assert.equal(decodeSubtitleText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Olá", "utf8")])), "Olá");
});

test("legenda UTF-16 com BOM é aceita", () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Você", "utf16le")]);
  assert.equal(decodeSubtitleText(utf16), "Você");
});

test("legenda UTF-8 com um byte 1252 solto mantém os acentos UTF-8", () => {
  // Antes, um único byte inválido fazia o arquivo inteiro ser lido como 1252: "JÃ¡ estÃ¡".
  const mixed = Buffer.concat([Buffer.from("Já está pensando?\n", "utf8"), Buffer.from([0x50, 0xe9]), Buffer.from("\n", "utf8")]);
  assert.equal(decodeSubtitleText(mixed), "Já está pensando?\nPé\n");
});

test("legenda publicada já estragada (UTF-8 relido como 1252) volta ao texto certo", () => {
  const stragada = Buffer.from("JÃ¡ estÃ¡ pensando nessas coisas?\nAÃ§Ã£o â€” VocÃª\n", "utf8");
  assert.equal(decodeSubtitleText(stragada), "Já está pensando nessas coisas?\nAção — Você\n");
});

test("texto correto com sequências parecidas não é alterado", () => {
  for (const text of ["IRMÃ… não", "VOCÊ… está aqui", "Ação é você", "Ã©"]) {
    assert.equal(decodeSubtitleText(Buffer.from(text, "utf8")), text === "Ã©" ? "é" : text);
  }
});

test("aspas curvas e travessão de legenda 1252 aparecem, não somem como controle", () => {
  const cp1252 = Buffer.from([0x93, 0x4f, 0x6c, 0xe1, 0x94, 0x20, 0x97, 0x20, 0x73, 0xe9, 0x85]);
  assert.equal(decodeSubtitleText(cp1252), "“Olá” — sé…");
});
