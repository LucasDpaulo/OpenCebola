import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const packageScript = path.join(root, "scripts/roku-empacotar.sh");

test("o pacote recebe build_version sem alterar o manifesto fonte", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cebola-roku-"));
  const zip = path.join(dir, "cebola-roku.zip");
  try {
    execFileSync("bash", [packageScript, zip], {
      cwd: root,
      env: { ...process.env, CEBOLA_ROKU_BUILD_VERSION: "83" }
    });
    const packaged = execFileSync("unzip", ["-p", zip, "manifest"], { encoding: "utf8" });
    assert.match(packaged, /^build_version=83$/m);
    assert.match(readFileSync(path.join(root, "apps/roku/manifest"), "utf8"), /^build_version=0$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("o empacotamento recusa build_version fora do contrato", () => {
  for (const value of ["", "0", "-1", "1.2", "100000", "abc"]) {
    const result = spawnSync("bash", [packageScript], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CEBOLA_ROKU_BUILD_VERSION: value }
    });
    assert.notEqual(result.status, 0, `valor aceito indevidamente: ${JSON.stringify(value)}`);
  }
});

test("o empacotamento exige build_version informado", () => {
  const env = { ...process.env };
  delete env.CEBOLA_ROKU_BUILD_VERSION;
  const result = spawnSync("bash", [packageScript], { cwd: root, encoding: "utf8", env });
  assert.notEqual(result.status, 0, "build_version ausente foi aceito indevidamente");
});

test("o empacotamento respeita caminhos relativos ao diretório inicial (INIT_CWD)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cebola-roku-rel-"));
  try {
    const relZip = "downloads/cebola-roku.zip";
    execFileSync("bash", [packageScript, relZip], {
      cwd: path.join(root, "apps/roku"),
      env: { ...process.env, INIT_CWD: dir, CEBOLA_ROKU_BUILD_VERSION: "42" }
    });
    const zip = path.join(dir, relZip);
    const packaged = execFileSync("unzip", ["-p", zip, "manifest"], { encoding: "utf8" });
    assert.match(packaged, /^build_version=42$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
