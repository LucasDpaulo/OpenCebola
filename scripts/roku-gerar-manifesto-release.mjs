import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

function fail(message) {
  throw new Error(`ERRO: ${message}`);
}

function parseBuildVersion(value) {
  if (!/^(?:[1-9]\d{0,4})$/.test(value)) fail("build Roku deve ser um inteiro entre 1 e 99999");
  const buildVersion = Number(value);
  if (buildVersion > 99999) fail("build Roku deve ser um inteiro entre 1 e 99999");
  return buildVersion;
}

function validateArtifactUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("URL do pacote Roku inválida");
  }

  if (
    url.protocol !== "https:"
    || !url.hostname
    || url.username
    || url.password
    || url.pathname !== "/downloads/cebola-roku.zip"
    || url.search
    || url.hash
  ) fail("URL do pacote Roku deve ser HTTPS e terminar em /downloads/cebola-roku.zip");

  return url.toString();
}

const [buildInput, zipPath, artifactUrl, outputPath] = process.argv.slice(2);
if (!buildInput || !zipPath || !artifactUrl || !outputPath || process.argv.length !== 6) {
  fail("uso: roku-gerar-manifesto-release.mjs <build> <zip> <https-url> <output-json>");
}

const buildVersion = parseBuildVersion(buildInput);
const url = validateArtifactUrl(artifactUrl);
const resolvedZip = path.resolve(zipPath);
const stats = statSync(resolvedZip, { throwIfNoEntry: false });
if (!stats?.isFile() || stats.size === 0) fail("pacote Roku ausente ou vazio");

const contents = readFileSync(resolvedZip);
const release = {
  version: `0.1.${buildVersion}`,
  buildVersion,
  url,
  sha256: createHash("sha256").update(contents).digest("hex"),
  size: stats.size
};

writeFileSync(path.resolve(outputPath), `${JSON.stringify(release, null, 2)}\n`, "utf8");
