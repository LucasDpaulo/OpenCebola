import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const doctor = path.join(root, "scripts/tizen-sdk-doctor.sh");

function doctorEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.CEBOLA_TIZEN_SDK_ROOT;
  delete env.TIZEN_STUDIO_HOME;
  return { ...env, ...overrides };
}

function executable(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(file, 0o755);
}

test("doctor encontra tizen e sdb na raiz explícita do SDK", () => {
  const sdk = mkdtempSync(path.join(tmpdir(), "cebola-tizen-sdk-"));
  try {
    executable(path.join(sdk, "tools/ide/bin/tizen"));
    executable(path.join(sdk, "tools/sdb"));
    const result = spawnSync("bash", [doctor], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, CEBOLA_TIZEN_SDK_ROOT: sdk }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`TIZEN_CLI=${sdk}/tools/ide/bin/tizen`));
    assert.match(result.stdout, new RegExp(`SDB_CLI=${sdk}/tools/sdb`));
    assert.match(result.stdout, /SDK_READY=yes/);
  } finally {
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("doctor falha quando a raiz não contém as duas ferramentas", () => {
  const sdk = mkdtempSync(path.join(tmpdir(), "cebola-tizen-sdk-"));
  try {
    executable(path.join(sdk, "tools/ide/bin/tizen"));
    const result = spawnSync("bash", [doctor], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, CEBOLA_TIZEN_SDK_ROOT: sdk }
    });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /SDB_CLI=missing/);
    assert.match(result.stdout, /SDK_READY=no/);
  } finally {
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("doctor encontra tizen e sdb em TIZEN_STUDIO_HOME", () => {
  const sdk = mkdtempSync(path.join(tmpdir(), "cebola-tizen-studio-"));
  try {
    executable(path.join(sdk, "tools/ide/bin/tizen"));
    executable(path.join(sdk, "tools/sdb"));
    const result = spawnSync("bash", [doctor], {
      cwd: root, encoding: "utf8",
      env: doctorEnv({ TIZEN_STUDIO_HOME: sdk })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`TIZEN_CLI=${sdk}/tools/ide/bin/tizen`));
    assert.match(result.stdout, new RegExp(`SDB_CLI=${sdk}/tools/sdb`));
    assert.match(result.stdout, /SDK_READY=yes/);
  } finally {
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("doctor encontra tizen e sdb no PATH quando não há raiz configurada", () => {
  const bin = mkdtempSync(path.join(tmpdir(), "cebola-tizen-bin-"));
  try {
    executable(path.join(bin, "tizen"));
    executable(path.join(bin, "sdb"));
    const result = spawnSync("bash", [doctor], {
      cwd: root, encoding: "utf8",
      env: doctorEnv({ PATH: `${bin}:${process.env.PATH}` })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`TIZEN_CLI=${bin}/tizen`));
    assert.match(result.stdout, new RegExp(`SDB_CLI=${bin}/sdb`));
    assert.match(result.stdout, /SDK_READY=yes/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("doctor prioriza TIZEN_STUDIO_HOME sobre o PATH", () => {
  const sdk = mkdtempSync(path.join(tmpdir(), "cebola-tizen-studio-"));
  const bin = mkdtempSync(path.join(tmpdir(), "cebola-tizen-bin-"));
  try {
    executable(path.join(sdk, "tools/ide/bin/tizen"));
    executable(path.join(sdk, "tools/sdb"));
    executable(path.join(bin, "tizen"));
    executable(path.join(bin, "sdb"));
    const result = spawnSync("bash", [doctor], {
      cwd: root, encoding: "utf8",
      env: doctorEnv({
        TIZEN_STUDIO_HOME: sdk,
        PATH: `${bin}:${process.env.PATH}`
      })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`TIZEN_CLI=${sdk}/tools/ide/bin/tizen`));
    assert.match(result.stdout, new RegExp(`SDB_CLI=${sdk}/tools/sdb`));
    assert.doesNotMatch(result.stdout, new RegExp(`TIZEN_CLI=${bin}`));
  } finally {
    rmSync(sdk, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("doctor prioriza CEBOLA_TIZEN_SDK_ROOT sobre TIZEN_STUDIO_HOME e PATH", () => {
  const explicitSdk = mkdtempSync(path.join(tmpdir(), "cebola-tizen-explicit-"));
  const studioSdk = mkdtempSync(path.join(tmpdir(), "cebola-tizen-studio-"));
  const bin = mkdtempSync(path.join(tmpdir(), "cebola-tizen-bin-"));
  try {
    executable(path.join(explicitSdk, "tools/ide/bin/tizen"));
    executable(path.join(explicitSdk, "tools/sdb"));
    executable(path.join(studioSdk, "tools/ide/bin/tizen"));
    executable(path.join(studioSdk, "tools/sdb"));
    executable(path.join(bin, "tizen"));
    executable(path.join(bin, "sdb"));
    const result = spawnSync("bash", [doctor], {
      cwd: root, encoding: "utf8",
      env: doctorEnv({
        CEBOLA_TIZEN_SDK_ROOT: explicitSdk,
        TIZEN_STUDIO_HOME: studioSdk,
        PATH: `${bin}:${process.env.PATH}`
      })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`TIZEN_CLI=${explicitSdk}/tools/ide/bin/tizen`));
    assert.match(result.stdout, new RegExp(`SDB_CLI=${explicitSdk}/tools/sdb`));
    assert.doesNotMatch(result.stdout, new RegExp(`TIZEN_CLI=${studioSdk}`));
    assert.doesNotMatch(result.stdout, new RegExp(`TIZEN_CLI=${bin}`));
  } finally {
    rmSync(explicitSdk, { recursive: true, force: true });
    rmSync(studioSdk, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
