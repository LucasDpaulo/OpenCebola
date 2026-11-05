import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const packager = path.join(root, "scripts/tizen-empacotar-wgt.sh");
const verifier = path.join(root, "scripts/tizen-verificar-wgt.sh");
const verifierParser = path.join(root, "scripts/tizen-verificar-wgt.py");
const sourceApp = path.join(root, "apps/tizen");
const sourceConfig = path.join(sourceApp, "config.xml");
const sourceWww = path.join(sourceApp, "www");

function makeSdk() {
  const sdk = mkdtempSync(path.join(tmpdir(), "cebola-tizen-sdk-"));
  const bin = path.join(sdk, "tools/ide/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "tizen"), `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  build-web)
    [[ $# -eq 3 && "$2" == "--" && "$3" == /* ]] || exit 65
    app="\${@: -1}"
    printf '%s\\n' "$*" >> "$CEBOLA_TIZEN_TEST_LOG"
    printf '%s\\n' 'build stdout'
    mkdir -p "$app/.buildResult"
    cp "$app/config.xml" "$app/.buildResult/config.xml"
    cp -R "$app/www" "$app/.buildResult/www"
    cp -R "$app/services" "$app/.buildResult/services"
    ;;
  package)
    [[ $# -eq 7 && "$2" == "-t" && "$3" == "wgt" && "$4" == "-s" && "$5" == "cebola-tv" && "$6" == "--" && "$7" == */.buildResult ]] || exit 65
    build="\${@: -1}"
    printf '%s\\n' "$*" >> "$CEBOLA_TIZEN_TEST_LOG"
    printf '%s\\n' 'package stdout'
    signature='<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="synthetic-c14n"/><SignatureMethod Algorithm="synthetic-signature"/><Reference URI=""><DigestMethod Algorithm="synthetic-digest"/><DigestValue>synthetic-digest-value</DigestValue></Reference></SignedInfo><SignatureValue>synthetic-signature-value</SignatureValue><KeyInfo><KeyName>synthetic-test-key</KeyName></KeyInfo></Signature>'
    printf '%s\\n' "$signature" > "$build/author-signature.xml"
    printf '%s\\n' "$signature" > "$build/signature1.xml"
    (cd "$build" && zip -qr CebolaTV.wgt config.xml author-signature.xml signature1.xml www services)
    ;;
  *) exit 64 ;;
esac
`);
  chmodSync(path.join(bin, "tizen"), 0o755);
  mkdirSync(path.join(sdk, "tools"), { recursive: true });
  writeFileSync(path.join(sdk, "tools/sdb"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(path.join(sdk, "tools/sdb"), 0o755);
  return sdk;
}

function makeProject() {
  const project = mkdtempSync(path.join(tmpdir(), "cebola-tizen-project-"));
  mkdirSync(path.join(project, "scripts"), { recursive: true });
  mkdirSync(path.join(project, "apps/tizen"), { recursive: true });
  cpSync(packager, path.join(project, "scripts/tizen-empacotar-wgt.sh"));
  cpSync(verifier, path.join(project, "scripts/tizen-verificar-wgt.sh"));
  cpSync(verifierParser, path.join(project, "scripts/tizen-verificar-wgt.py"));
  cpSync(sourceConfig, path.join(project, "apps/tizen/config.xml"));
  cpSync(sourceWww, path.join(project, "apps/tizen/www"), { recursive: true });
  cpSync(path.join(root, "apps/tizen/services"), path.join(project, "apps/tizen/services"), { recursive: true });
  cpSync(path.join(root, "scripts/tizen-build-engine.cjs"), path.join(project, "scripts/tizen-build-engine.cjs"));
  const runtime = "third_party/nuvio-tvsmart/services/tizen/runtime/media-http.cjs";
  mkdirSync(path.dirname(path.join(project, runtime)), { recursive: true });
  cpSync(path.join(root, runtime), path.join(project, runtime));
  cpSync(path.join(root, "third_party/nuvio-tvsmart/LICENSE"), path.join(project, "third_party/nuvio-tvsmart/LICENSE"));
  return project;
}

function makeFaultTools(command) {
  const directory = mkdtempSync(path.join(tmpdir(), "cebola-tizen-tools-"));
  writeFileSync(path.join(directory, command), `#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  [[ "$argument" == */.cebola-tizen-wgt.* ]] && exit 74
done
exec /usr/bin/${command} "$@"
`);
  chmodSync(path.join(directory, command), 0o755);
  return directory;
}

function snapshotTree(directory) {
  const snapshot = [];
  function visit(current, relative = "") {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        snapshot.push([name, "directory"]);
        visit(absolute, name);
      } else if (entry.isSymbolicLink()) {
        snapshot.push([name, "symlink", readlinkSync(absolute)]);
      } else {
        snapshot.push([name, "file", readFileSync(absolute).toString("base64")]);
      }
    }
  }
  visit(directory);
  return snapshot;
}

function snapshotEntry(file) {
  try {
    const stats = lstatSync(file);
    if (stats.isSymbolicLink()) return ["symlink", readlinkSync(file)];
    if (stats.isDirectory()) return ["directory", snapshotTree(file)];
    return ["file", stats.ino, stats.size, stats.mtimeMs, readFileSync(file).toString("base64")];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function packageWith({
  sdk,
  profile,
  destination,
  cwd = root,
  script = packager,
  extraArguments = [],
  pathPrefix,
}) {
  const arguments_ = [script];
  if (destination !== undefined) arguments_.push(destination);
  arguments_.push(...extraArguments);
  return spawnSync("bash", arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
      CEBOLA_TIZEN_SDK_ROOT: sdk,
      CEBOLA_TIZEN_PROFILE: profile,
      CEBOLA_TIZEN_TEST_LOG: path.join(sdk, "calls.log"),
    },
  });
}

test("empacotador publica WGT em staging sem modificar config.xml nem a árvore www", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cebola-tizen-package-"));
  const sdk = makeSdk();
  const destination = path.join(fixture, "nested", "cebola-tizen.wgt");
  const configBefore = readFileSync(sourceConfig);
  const wwwBefore = snapshotTree(sourceWww);
  try {
    const result = packageWith({ sdk, profile: "cebola-tv", destination });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(destination), true);
    assert.equal(result.stdout, `${destination}\n`);
    assert.match(
      readFileSync(path.join(sdk, "calls.log"), "utf8"),
      /^build-web -- .+\npackage -t wgt -s cebola-tv -- .+\/\.buildResult\n$/,
    );
    assert.deepEqual(readFileSync(sourceConfig), configBefore);
    assert.deepEqual(snapshotTree(sourceWww), wwwBefore);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("destino padrão é provado em uma cópia temporária e não toca o dist real", () => {
  const project = makeProject();
  const fixture = mkdtempSync(path.join(tmpdir(), "cebola-tizen-package-"));
  const sdk = makeSdk();
  const copiedPackager = path.join(project, "scripts/tizen-empacotar-wgt.sh");
  const destination = path.join(project, "apps/tizen/dist/cebola-tizen.wgt");
  const realDestination = path.join(root, "apps/tizen/dist/cebola-tizen.wgt");
  const realDestinationBefore = snapshotEntry(realDestination);
  try {
    const result = packageWith({ sdk, profile: "cebola-tv", cwd: fixture, script: copiedPackager });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${destination}\n`);
    assert.equal(existsSync(destination), true);
    assert.deepEqual(snapshotEntry(realDestination), realDestinationBefore);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("empacotador exige no máximo um destino e a extensão .wgt", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cebola-tizen-package-"));
  const sdk = makeSdk();
  try {
    const first = path.join(fixture, "primeiro.wgt");
    const extra = packageWith({
      sdk,
      profile: "cebola-tv",
      destination: first,
      extraArguments: [path.join(fixture, "segundo.wgt")],
    });
    assert.notEqual(extra.status, 0);
    assert.equal(existsSync(first), false);

    const invalid = path.join(fixture, "cebola-tizen.zip");
    const invalidResult = packageWith({ sdk, profile: "cebola-tv", destination: invalid });
    assert.notEqual(invalidResult.status, 0);
    assert.equal(existsSync(invalid), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("empacotador recusa sobreposição com config.xml, www e .buildResult", () => {
  for (const relativeDestination of ["config.xml", "www/pacote.wgt", ".buildResult/pacote.wgt"]) {
    const project = makeProject();
    const sdk = makeSdk();
    const app = path.join(project, "apps/tizen");
    const configBefore = readFileSync(path.join(app, "config.xml"));
    const wwwBefore = snapshotTree(path.join(app, "www"));
    const destination = path.join(app, relativeDestination);
    try {
      const result = packageWith({
        sdk,
        profile: "cebola-tv",
        destination,
        script: path.join(project, "scripts/tizen-empacotar-wgt.sh"),
      });
      assert.notEqual(result.status, 0, `destino aceito: ${relativeDestination}`);
      assert.deepEqual(readFileSync(path.join(app, "config.xml")), configBefore);
      assert.deepEqual(snapshotTree(path.join(app, "www")), wwwBefore);
      assert.equal(existsSync(path.join(app, ".buildResult/pacote.wgt")), false);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(sdk, { recursive: true, force: true });
    }
  }
});

test("empacotador recusa destino por symlink e preserva o arquivo apontado", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cebola-tizen-package-"));
  const sdk = makeSdk();
  const target = path.join(fixture, "existente.wgt");
  const destination = path.join(fixture, "atalho.wgt");
  try {
    writeFileSync(target, "artefato anterior");
    symlinkSync(target, destination);
    const result = packageWith({ sdk, profile: "cebola-tv", destination });
    assert.notEqual(result.status, 0);
    assert.equal(lstatSync(destination).isSymbolicLink(), true);
    assert.equal(readFileSync(target, "utf8"), "artefato anterior");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("publicação atômica substitui arquivo regular somente após sucesso", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cebola-tizen-package-"));
  const sdk = makeSdk();
  const destination = path.join(fixture, "cebola-tizen.wgt");
  try {
    writeFileSync(destination, "artefato anterior");
    const result = packageWith({ sdk, profile: "cebola-tv", destination });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(readFileSync(destination, "utf8"), "artefato anterior");
    assert.deepEqual(readdirSync(fixture).filter((name) => name.startsWith(".cebola-tizen-wgt.")), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("falhas de cópia e rename preservam o artefato anterior sem arquivo parcial", () => {
  for (const command of ["cp", "mv"]) {
    const fixture = mkdtempSync(path.join(tmpdir(), "cebola-tizen-package-"));
    const sdk = makeSdk();
    const tools = makeFaultTools(command);
    const destination = path.join(fixture, "cebola-tizen.wgt");
    try {
      writeFileSync(destination, "artefato anterior");
      const result = packageWith({ sdk, profile: "cebola-tv", destination, pathPrefix: tools });
      assert.notEqual(result.status, 0, `${command} não provocou falha`);
      assert.equal(readFileSync(destination, "utf8"), "artefato anterior");
      assert.deepEqual(readdirSync(fixture).filter((name) => name.startsWith(".cebola-tizen-wgt.")), []);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(sdk, { recursive: true, force: true });
      rmSync(tools, { recursive: true, force: true });
    }
  }
});

test("empacotador recusa perfil Tizen vazio", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cebola-tizen-package-"));
  const sdk = makeSdk();
  const destination = path.join(fixture, "cebola-tizen.wgt");
  try {
    assert.notEqual(packageWith({ sdk, profile: "", destination }).status, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});
