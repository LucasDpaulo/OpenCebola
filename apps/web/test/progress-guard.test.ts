import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Teste-guarda do salvamento de progresso: só o módulo `app/progress/` fala com `/v1/progress`.
 * Tela ou player que montar a própria chamada volta a espalhar a regra — foi assim que o ID do
 * vídeo, o cenário e o 401 divergiram entre gravação e leitura (0d849e5, dba18c1, 76a46e0).
 */
const appDir = fileURLToPath(new URL("../app", import.meta.url));
const moduleDir = join(appDir, "progress");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("nenhum arquivo fora de app/progress/ cita /v1/progress", () => {
  const files = sourceFiles(appDir);
  // Sanidade: se a varredura não achar nada (pasta movida), o teste não pode passar em silêncio.
  assert.ok(files.length > 50, `varredura achou só ${files.length} arquivos em ${appDir}`);
  assert.ok(files.some((file) => file.startsWith(moduleDir + sep)), "o módulo app/progress/ não foi encontrado");

  const offenders = files
    .filter((file) => !file.startsWith(moduleDir + sep))
    .filter((file) => readFileSync(file, "utf8").includes("/v1/progress"))
    .map((file) => relative(appDir, file));

  assert.deepEqual(offenders, [], `use o módulo app/progress/ em vez de chamar /v1/progress: ${offenders.join(", ")}`);
});
