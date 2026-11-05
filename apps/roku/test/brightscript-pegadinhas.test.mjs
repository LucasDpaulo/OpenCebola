import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Pegadinhas do BrightScript achadas na Roku real (01/11/2026), que nenhum teste local executa.
const app = path.resolve(import.meta.dirname, "..");
const fontes = ["source", "components", "telas/components"].flatMap((dir) =>
  readdirSync(path.join(app, dir))
    .filter((nome) => nome.endsWith(".brs"))
    .map((nome) => ({ nome: `${dir}/${nome}`, texto: readFileSync(path.join(app, dir, nome), "utf8") }))
);

test("roUrlTransfer não tem GetResponseCode(): o status vem do roUrlEvent", () => {
  for (const { nome, texto } of fontes) {
    assert.doesNotMatch(texto, /transfer\.GetResponseCode\(/i, nome);
    assert.doesNotMatch(texto, /\.(GetToString|PostFromString)\(/i, `${nome}: use a versão Async`);
  }
});

test("JSON enviado à API usa chaves entre aspas para manter maiúsculas", () => {
  for (const { nome, texto } of fontes) {
    for (const [, corpo] of texto.matchAll(/FormatJson\(\s*\{([^}]*)\}/gi)) {
      assert.doesNotMatch(corpo, /(^|,)\s*[a-z_]\w*[A-Z]\w*\s*:/, `${nome}: chave camelCase sem aspas vira minúscula`);
    }
  }
});
