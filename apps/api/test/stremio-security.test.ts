import assert from "node:assert/strict";
import test from "node:test";
import { StremioAddonGateway } from "../src/stremio/gateway.js";
import { validatePublicHttpsUrl, validatePublicMediaUrl } from "../src/stremio/safe-http.js";
import { StremioVault } from "../src/stremio/vault.js";
import type { AddonDescriptor } from "../src/stremio/types.js";

const descriptor: AddonDescriptor = {
  manifest: {
    id: "org.example.safe",
    version: "1.0.0",
    name: "Catálogo seguro",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [{ id: "popular", type: "movie", name: "<b>Populares</b>" }]
  },
  transportUrl: "https://addon.example/manifest.json"
};

test("cofre cifra token e coleção com contexto autenticado por casa", () => {
  const vault = new StremioVault(Buffer.alloc(32, 7));
  const encrypted = vault.encrypt("segredo-stremio", "casa-a:auth");
  assert.doesNotMatch(encrypted.ciphertext, /segredo-stremio/);
  assert.equal(vault.decrypt(encrypted, "casa-a:auth"), "segredo-stremio");
  assert.throws(() => vault.decrypt(encrypted, "casa-b:auth"));
  assert.throws(() => new StremioVault(Buffer.alloc(16)));
});

test("gateway lista somente catálogos do manifesto e remove HTML do texto", () => {
  const catalogs = new StremioAddonGateway().listCatalogs([descriptor]);
  assert.deepEqual(catalogs, [{
    addonId: "org.example.safe",
    catalogId: "popular",
    type: "movie",
    name: "Populares"
  }]);
});

test("política de rede aceita somente HTTPS público na porta padrão", async () => {
  assert.equal((await validatePublicHttpsUrl("https://1.1.1.1/video.mp4")).protocol, "https:");
  await assert.rejects(() => validatePublicHttpsUrl("http://1.1.1.1/video.mp4"));
  await assert.rejects(() => validatePublicHttpsUrl("https://127.0.0.1/manifest.json"));
  await assert.rejects(() => validatePublicHttpsUrl("https://10.0.0.1/manifest.json"));
  await assert.rejects(() => validatePublicHttpsUrl("https://localhost/manifest.json"));
  await assert.rejects(() => validatePublicHttpsUrl("https://1.1.1.1:8443/video.mp4"));
});

test("política de rede recusa credenciais, URL longa e faixas reservadas sem tocar a rede", async () => {
  // ipaddr.js#range() nestes literais: ::1 → loopback, 0.0.0.0 → unspecified,
  // 169.254.1.1 → linkLocal, 100.64.0.1 → carrierGradeNat; nada disso é "unicast",
  // então a política recusa antes de qualquer resolução DNS.
  await assert.rejects(() => validatePublicHttpsUrl("https://usuario:senha@1.1.1.1/video.mp4"));
  await assert.rejects(() => validatePublicHttpsUrl(`https://1.1.1.1/${"a".repeat(4_100)}`));
  await assert.rejects(() => validatePublicHttpsUrl("https://[::1]/video.mp4"));
  await assert.rejects(() => validatePublicHttpsUrl("https://0.0.0.0/video.mp4"));
  await assert.rejects(() => validatePublicHttpsUrl("https://169.254.1.1/video.mp4"));
  await assert.rejects(() => validatePublicHttpsUrl("https://100.64.0.1/video.mp4"));
  await assert.rejects(() => validatePublicHttpsUrl("file:///etc/passwd"));
});

test("validatePublicMediaUrl libera http público na 80 só com allowInsecure, mantém as demais faixas bloqueadas", async () => {
  const insecure = { allowInsecure: true };
  assert.equal((await validatePublicMediaUrl("http://1.1.1.1/video.mp4", insecure)).protocol, "http:");
  assert.equal((await validatePublicMediaUrl("https://1.1.1.1/video.mp4", insecure)).protocol, "https:");
  await assert.rejects(() => validatePublicMediaUrl("http://1.1.1.1:8080/x.mp4", insecure)); // porta não padrão
  await assert.rejects(() => validatePublicMediaUrl("http://10.0.0.1/x.mp4", insecure)); // IP privado
  await assert.rejects(() => validatePublicMediaUrl("http://[::1]/x.mp4", insecure)); // loopback IPv6
  await assert.rejects(() => validatePublicMediaUrl("http://localhost/x.mp4", insecure));
  await assert.rejects(() => validatePublicMediaUrl("magnet:?xt=urn:btih:0000", insecure));
  await assert.rejects(() => validatePublicMediaUrl("file:///etc/passwd", insecure));
  await assert.rejects(() => validatePublicMediaUrl("javascript:alert(1)", insecure));
  await assert.rejects(() => validatePublicMediaUrl("data:text/plain;base64,eA==", insecure));
  await assert.rejects(() => validatePublicMediaUrl("http://usuario:senha@1.1.1.1/x.mp4", insecure));

  // Flag desligada: http continua recusado, prova de que o comportamento default não mudou.
  await assert.rejects(() => validatePublicMediaUrl("http://1.1.1.1/video.mp4", { allowInsecure: false }));
});
