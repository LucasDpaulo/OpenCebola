import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Teste-guarda do setor de pulos: pulos só leem a posição e pedem `seek`; não decidem início,
 * retomada nem salvamento. Se um arquivo de `app/player/pulos/` passar a importar o progresso, a
 * guarda do ponto salvo ou citar os termos abaixo, o pulo está entrando em área que não é dele.
 */
const pulosDir = fileURLToPath(new URL("../app/player/pulos", import.meta.url));
const proibidos = ["resumeFrom", "progressTracker", "sourceSwitchPosition", "startFromBeginning"];

const arquivos = readdirSync(pulosDir).filter((nome) => /\.(ts|tsx)$/.test(nome));

test("a pasta app/player/pulos/ existe e tem arquivos", () => {
  assert.ok(arquivos.length >= 3, `varredura achou só ${arquivos.length} arquivos em ${pulosDir}`);
});

test("pulos não importam progresso nem a guarda do ponto salvo", () => {
  const ofensores = arquivos.filter((nome) => {
    const fonte = readFileSync(join(pulosDir, nome), "utf8");
    return /from\s+["'][^"']*(?:\/progress(?:\/|["'])|guarda-do-ponto-salvo)/.test(fonte);
  });
  assert.deepEqual(ofensores, [], `pulos não podem importar progress nem guarda-do-ponto-salvo: ${ofensores.join(", ")}`);
});

test("pulos não citam início, retomada nem salvamento", () => {
  const ofensores = arquivos.flatMap((nome) => {
    const fonte = readFileSync(join(pulosDir, nome), "utf8");
    return proibidos.filter((termo) => fonte.includes(termo)).map((termo) => `${nome}: ${termo}`);
  });
  assert.deepEqual(ofensores, [], `termos proibidos em pulos: ${ofensores.join(", ")}`);
});
