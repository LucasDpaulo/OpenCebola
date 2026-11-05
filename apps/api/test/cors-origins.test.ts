import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

const environment = {
  NODE_ENV: "test" as const,
  CEBOLA_API_HOST: "127.0.0.1",
  CEBOLA_API_PORT: 3001,
  CEBOLA_WEB_ORIGIN: "http://localhost:3000",
  CEBOLA_SESSION_TTL_SECONDS: 3_600
};

// Um preflight é o que o navegador (e a WebView do app) dispara ANTES do POST de verdade.
// Se ele não passar, nenhuma rota chega a ser executada e o Bearer nem é lido — por isso
// este arquivo testa o preflight, e não a rota.
function preflight(app: Awaited<ReturnType<typeof buildApp>>, origin: string) {
  return app.inject({
    method: "OPTIONS",
    url: "/v1/auth/device/claim",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,authorization"
    }
  });
}

test("preflight da origem do site continua recebendo credenciais", async () => {
  const app = await buildApp(environment);

  const response = await preflight(app, "http://localhost:3000");

  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:3000");
  assert.equal(response.headers["access-control-allow-credentials"], "true");

  await app.close();
});

test("preflight das WebViews nativas, incluindo Tauri, passa sem credenciais", async () => {
  const app = await buildApp(environment);

  for (const origin of ["https://localhost", "http://localhost", "capacitor://localhost", "tauri://localhost", "http://tauri.localhost"]) {
    const response = await preflight(app, origin);

    assert.equal(response.headers["access-control-allow-origin"], origin, origin);
    // O ponto inteiro da separação: abrir a lista de origens COM credentials abriria as
    // rotas que autenticam por cookie para essas origens. Cliente nativo usa Bearer, que
    // o navegador nunca anexa sozinho, então ele não precisa de credenciais.
    assert.equal(response.headers["access-control-allow-credentials"], undefined, origin);
  }

  await app.close();
});

test("preflight do app de TV aceita as origens medidas sem credenciais", async () => {
  const app = await buildApp(environment);

  for (const origin of ["null", "file://"]) {
    const response = await preflight(app, origin);

    assert.equal(response.headers["access-control-allow-origin"], origin);
    assert.equal(response.headers["access-control-allow-credentials"], undefined);
  }

  await app.close();
});

test("preflight de origem desconhecida não é liberado", async () => {
  const app = await buildApp(environment);

  const response = await preflight(app, "https://cebola-falso.example");

  assert.notEqual(response.headers["access-control-allow-origin"], "https://cebola-falso.example");
  assert.equal(response.headers["access-control-allow-credentials"], undefined);

  await app.close();
});
