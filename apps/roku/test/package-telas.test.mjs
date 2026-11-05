import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const telasScript = path.join(root, "scripts/roku-empacotar-telas.sh");
const cascaScript = path.join(root, "scripts/roku-empacotar.sh");
const configPath = path.join(root, "apps/roku/telas/components/InstanceConfig.brs");
let originalConfig;
before(() => {
  originalConfig = existsSync(configPath) ? readFileSync(configPath) : null;
  writeFileSync(configPath, 'function openCebolaApiUrl() as String\n  return "https://api.example.org"\nend function\n');
});
after(() => {
  if (originalConfig) writeFileSync(configPath, originalConfig);
  else rmSync(configPath, { force: true });
});


test("o ZIP das telas é válido e declara a biblioteca", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cebola-roku-telas-"));
  const zip = path.join(dir, "telas.zip");
  try {
    execFileSync("bash", [telasScript, zip], { cwd: root });
    execFileSync("unzip", ["-t", zip], { stdio: "ignore" });
    const manifest = execFileSync("unzip", ["-p", zip, "manifest"], { encoding: "utf8" });
    assert.match(manifest, /^sg_component_libs_provided=CebolaTelas$/m);
    const lista = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" });
    assert.match(lista, /components\/CebolaApp\.xml/);
    assert.match(lista, /components\/InstanceConfig\.brs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CEBOLA_ROKU_TELAS_URL vale no pacote sem alterar o manifesto fonte", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cebola-roku-url-"));
  const zip = path.join(dir, "casca.zip");
  const url = "http://192.0.2.10:8787/cebola-roku-telas.zip";
  try {
    execFileSync("bash", [cascaScript, zip], {
      cwd: root,
      env: { ...process.env, CEBOLA_ROKU_BUILD_VERSION: "9", CEBOLA_ROKU_TELAS_URL: url }
    });
    const empacotado = execFileSync("unzip", ["-p", zip, "manifest"], { encoding: "utf8" });
    assert.ok(empacotado.includes(`cebola_telas_url=${url}\n`));
    const fonte = readFileSync(path.join(root, "apps/roku/manifest"), "utf8");
    assert.match(fonte, /^cebola_telas_url=https:\/\/instance\.example\.invalid\/downloads\/cebola-roku-telas\.zip$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a casca não chama a API e não guarda sessão", () => {
  for (const dir of ["source", "components"]) {
    const base = path.join(root, "apps/roku", dir);
    for (const nome of readdirSync(base)) {
      const texto = readFileSync(path.join(base, nome), "utf8");
      assert.doesNotMatch(texto, /\/v1\//, `${dir}/${nome}`);
      assert.doesNotMatch(texto, /PairingTask|"session"/, `${dir}/${nome}`);
    }
  }
});

test("a biblioteca leva o pareamento", () => {
  const lista = execFileSync("bash", [telasScript, path.join(tmpdir(), "t-pareamento.zip")], { cwd: root, encoding: "utf8" });
  assert.match(lista, /OK/);
  assert.ok(readFileSync(path.join(root, "apps/roku/telas/components/PairingTask.brs"), "utf8").includes("/v1/auth/device/claim"));
  rmSync(path.join(tmpdir(), "t-pareamento.zip"), { force: true });
});

test("a URL anterior deriva de cebola_telas_url trocando .zip por -anterior.zip", () => {
  const brs = readFileSync(path.join(root, "apps/roku/components/MainScene.brs"), "utf8");
  const [, padrao, troca] = brs.match(/CreateObject\("roRegex", "([^"]+)", ""\)\.Replace\(base, "([^"]+)"\)/);
  const derivar = (url) => url.replace(new RegExp(padrao), troca);
  assert.equal(
    derivar("https://instance.example.invalid/downloads/cebola-roku-telas.zip"),
    "https://instance.example.invalid/downloads/cebola-roku-telas-anterior.zip"
  );
  assert.equal(
    derivar("http://192.0.2.10:8787/cebola-roku-telas.zip"),
    "http://192.0.2.10:8787/cebola-roku-telas-anterior.zip"
  );
});

test("a casca grava a tentativa e só marca saudável depois de pronto", () => {
  const brs = readFileSync(path.join(root, "apps/roku/components/MainScene.brs"), "utf8");
  assert.match(brs, /telasTentativa/);
  assert.match(brs, /observeField\("pronto"/);
  assert.match(brs, /sub onSaudavel\(\)[\s\S]*telasSaudavel", "1"/);
});
