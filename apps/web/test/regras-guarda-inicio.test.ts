import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Teste-guarda da regra de início: de onde o vídeo começa é decidido num lugar só
 * (`app/player/regras/inicio.ts`). Outro lugar calculando o ponto de partida por conta própria é
 * como nasceu a divergência "assistir do começo" só valer no navegador.
 */
const appDir = fileURLToPath(new URL("../app", import.meta.url));
const progressDir = join(appDir, "progress");
const regrasDir = join(appDir, "player", "regras");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const dentroDe = (file: string, directory: string) => file.startsWith(directory + sep);

function chamam(files: readonly string[], chamada: string): string[] {
  return files.filter((file) => readFileSync(file, "utf8").includes(chamada)).map((file) => relative(appDir, file));
}

test("só app/progress/ e app/player/regras/ chamam pontoDeRetomada(", () => {
  const files = sourceFiles(appDir);
  // Sanidade: se a varredura não achar nada (pasta movida), o teste não pode passar em silêncio.
  assert.ok(files.length > 50, `varredura achou só ${files.length} arquivos em ${appDir}`);
  assert.ok(files.some((file) => dentroDe(file, regrasDir)), "a pasta app/player/regras/ não foi encontrada");

  const offenders = chamam(files.filter((file) => !dentroDe(file, progressDir) && !dentroDe(file, regrasDir)), "pontoDeRetomada(");
  assert.deepEqual(offenders, [], `use decidirInicio em vez de pontoDeRetomada: ${offenders.join(", ")}`);
});

test("só app/player/regras/ chama initialPlaybackPosition(", () => {
  const files = sourceFiles(appDir);
  assert.ok(files.length > 50, `varredura achou só ${files.length} arquivos em ${appDir}`);

  const offenders = chamam(
    files.filter((file) => !dentroDe(file, regrasDir)),
    "initialPlaybackPosition("
  );
  assert.deepEqual(offenders, [], `use decidirInicio em vez de initialPlaybackPosition: ${offenders.join(", ")}`);
});
