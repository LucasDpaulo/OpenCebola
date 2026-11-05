import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const metadataScript = path.join(root, "scripts/roku-gerar-manifesto-release.mjs");

test("gera metadados públicos e íntegros para o pacote Roku", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cebola-roku-release-"));
  const zip = path.join(dir, "cebola-roku.zip");
  const output = path.join(dir, "cebola-roku-latest.json");
  const content = Buffer.from("pacote Roku de teste");
  try {
    writeFileSync(zip, content);
    execFileSync("node", [metadataScript, "83", zip, "https://example.test/downloads/cebola-roku.zip", output]);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
      version: "0.1.83",
      buildVersion: 83,
      url: "https://example.test/downloads/cebola-roku.zip",
      sha256: createHash("sha256").update(content).digest("hex"),
      size: statSync(zip).size
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recusa metadados fora do contrato de publicação", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cebola-roku-release-"));
  const zip = path.join(dir, "cebola-roku.zip");
  const output = path.join(dir, "cebola-roku-latest.json");
  try {
    writeFileSync(zip, "zip de teste");
    for (const [build, url] of [
      ["0", "https://example.test/downloads/cebola-roku.zip"],
      ["100000", "https://example.test/downloads/cebola-roku.zip"],
      ["83", "http://example.test/downloads/cebola-roku.zip"],
      ["83", "https://example.test/outro.zip"]
    ]) {
      assert.throws(() => execFileSync("node", [metadataScript, build, zip, url, output], { stdio: "ignore" }));
    }
    assert.throws(() => execFileSync("node", [metadataScript, "83", path.join(dir, "ausente.zip"), "https://example.test/downloads/cebola-roku.zip", output], { stdio: "ignore" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
