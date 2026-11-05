import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Teste-guarda da regra de faixas: a escolha AUTOMÁTICA de áudio e legenda vive em
 * `app/player/regras/faixas.ts` (`aplicarFaixas`). Outro lugar decidindo por conta própria é como
 * nasceram duas legendas na tela.
 */
const appDir = fileURLToPath(new URL("../app", import.meta.url));
const regrasDir = join(appDir, "player", "regras");
// Arquivos que DEFINEM as funções de decisão.
const definem = [join(appDir, "player", "subtitle-selection.ts"), join(appDir, "player", "playback-scenario.ts")];
// Exceção: a troca MANUAL de áudio no menu (a pessoa escolheu a trilha; a legenda acompanha o
// idioma novo). Escolha manual da pessoa não é escolha automática.
const excecaoManual = join(appDir, "player", "player-controls-scenario.ts");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("só app/player/regras/ decide faixas automáticas (subtitleForAudio, originalAudioTrackId, resolveContinuityTrack)", () => {
  const files = sourceFiles(appDir);
  // Sanidade: se a varredura não achar nada (pasta movida), o teste não pode passar em silêncio.
  assert.ok(files.length > 50, `varredura achou só ${files.length} arquivos em ${appDir}`);
  assert.ok(files.some((file) => file.startsWith(regrasDir + sep)), "a pasta app/player/regras/ não foi encontrada");

  const offenders = files
    .filter((file) => !file.startsWith(regrasDir + sep) && !definem.includes(file) && file !== excecaoManual)
    .filter((file) => /\b(subtitleForAudio|originalAudioTrackId|resolveContinuityTrack)\(/.test(readFileSync(file, "utf8")))
    .map((file) => relative(appDir, file));
  assert.deepEqual(offenders, [], `use aplicarFaixas em vez de decidir faixas aqui: ${offenders.join(", ")}`);
});
