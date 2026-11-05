import assert from "node:assert/strict";
import test from "node:test";
import { getSupabaseEnvironment, readEnvironment } from "../src/env.js";

test("desenvolvimento local pode iniciar sem segredos e produção falha fechada", () => {
  const development = readEnvironment({ NODE_ENV: "development" });
  assert.equal(getSupabaseEnvironment(development), null);
  assert.throws(() => readEnvironment({ NODE_ENV: "production" }));
});

test("configuração parcial ou pepper curto é rejeitada", () => {
  assert.throws(() => readEnvironment({
    NODE_ENV: "development",
    SUPABASE_URL: "https://project.supabase.co"
  }));
  assert.throws(() => readEnvironment({
    NODE_ENV: "development",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "publishable-key-with-enough-length",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-with-enough-length",
    CEBOLA_PIN_PEPPER_BASE64: Buffer.alloc(16, 1).toString("base64"),
    CEBOLA_STREMIO_VAULT_KEY_BASE64: Buffer.alloc(32, 2).toString("base64")
  }));
});

test("CEBOLA_TRUST_PROXY desliga por padrão e aceita apenas true/false", () => {
  assert.equal(readEnvironment({ NODE_ENV: "development" }).CEBOLA_TRUST_PROXY, false);
  assert.equal(
    readEnvironment({ NODE_ENV: "development", CEBOLA_TRUST_PROXY: "true" }).CEBOLA_TRUST_PROXY,
    true
  );
  assert.equal(
    readEnvironment({ NODE_ENV: "development", CEBOLA_TRUST_PROXY: "false" }).CEBOLA_TRUST_PROXY,
    false
  );
  assert.throws(() => readEnvironment({ NODE_ENV: "development", CEBOLA_TRUST_PROXY: "1" }));
  assert.throws(() => readEnvironment({ NODE_ENV: "development", CEBOLA_TRUST_PROXY: "yes" }));
});

test("CEBOLA_ALLOW_INSECURE_STREAMS desliga por padrão e aceita apenas true/false", () => {
  assert.equal(readEnvironment({ NODE_ENV: "development" }).CEBOLA_ALLOW_INSECURE_STREAMS, false);
  assert.equal(
    readEnvironment({ NODE_ENV: "development", CEBOLA_ALLOW_INSECURE_STREAMS: "true" })
      .CEBOLA_ALLOW_INSECURE_STREAMS,
    true
  );
  assert.equal(
    readEnvironment({ NODE_ENV: "development", CEBOLA_ALLOW_INSECURE_STREAMS: "false" })
      .CEBOLA_ALLOW_INSECURE_STREAMS,
    false
  );
  assert.throws(() => readEnvironment({ NODE_ENV: "development", CEBOLA_ALLOW_INSECURE_STREAMS: "1" }));
  assert.throws(() => readEnvironment({ NODE_ENV: "development", CEBOLA_ALLOW_INSECURE_STREAMS: "yes" }));
});

test("CEBOLA_TMDB_READ_TOKEN é opcional e rejeita credencial curta", () => {
  assert.equal(readEnvironment({ NODE_ENV: "development" }).CEBOLA_TMDB_READ_TOKEN, undefined);
  const token = "t".repeat(100);
  assert.equal(readEnvironment({ NODE_ENV: "development", CEBOLA_TMDB_READ_TOKEN: token }).CEBOLA_TMDB_READ_TOKEN, token);
  assert.throws(() => readEnvironment({ NODE_ENV: "development", CEBOLA_TMDB_READ_TOKEN: "curto" }));
});

test("token Real-Debrid é opcional, mas não aceita valor curto", () => {
  assert.equal(readEnvironment({ NODE_ENV: "development" }).CEBOLA_REAL_DEBRID_TOKEN, undefined);
  assert.equal(
    readEnvironment({ NODE_ENV: "development", CEBOLA_REAL_DEBRID_TOKEN: "token-com-tamanho-suficiente" })
      .CEBOLA_REAL_DEBRID_TOKEN,
    "token-com-tamanho-suficiente"
  );
  assert.throws(() => readEnvironment({ NODE_ENV: "development", CEBOLA_REAL_DEBRID_TOKEN: "curto" }));
});

test("chave SubDL fica disponível apenas na configuração privada da API", () => {
  assert.equal(readEnvironment({ NODE_ENV: "development" }).CEBOLA_SUBDL_API_KEY, undefined);
  const key = "subdl_" + "a".repeat(32);
  assert.equal(readEnvironment({ NODE_ENV: "development", CEBOLA_SUBDL_API_KEY: key }).CEBOLA_SUBDL_API_KEY, key);
  assert.throws(() => readEnvironment({ NODE_ENV: "development", CEBOLA_SUBDL_API_KEY: "curta" }));
});

test("configuração completa decodifica pepper de 256 bits", () => {
  const environment = readEnvironment({
    NODE_ENV: "production",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "publishable-key-with-enough-length",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-with-enough-length",
    CEBOLA_PIN_PEPPER_BASE64: Buffer.alloc(32, 7).toString("base64"),
    CEBOLA_STREMIO_VAULT_KEY_BASE64: Buffer.alloc(32, 8).toString("base64")
  });
  const supabase = getSupabaseEnvironment(environment);
  assert.equal(supabase?.pinPepper.byteLength, 32);
  assert.equal(supabase?.stremioVaultKey.byteLength, 32);
});
