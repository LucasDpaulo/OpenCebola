import assert from "node:assert/strict";
import test from "node:test";
import { getCredential, setCredential } from "../app/api-client.js";
import { claimSession, requestPairingCode, restoreSession } from "../app/native/pairing.js";

function responderCom(rotas: Record<string, { status: number; body: unknown }>) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const caminho = new URL(String(url)).pathname;
    const resposta = rotas[caminho];
    if (!resposta) throw new Error(`rota inesperada: ${caminho}`);
    // O 202 do servidor vem sem corpo nenhum (reply.code(202).send()). O dublê reproduz
    // isso, senão o teste passaria por um caminho que não existe em produção.
    if (resposta.body === null) return new Response(null, { status: resposta.status });
    return new Response(JSON.stringify(resposta.body), {
      status: resposta.status,
      headers: { "content-type": "application/json" }
    });
  }) as typeof globalThis.fetch;
}

function armazenamentoFalso(inicial: Record<string, string> = {}) {
  const dados = { ...inicial };
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => dados[k] ?? null,
      setItem: (k: string, v: string) => { dados[k] = v; },
      removeItem: (k: string) => { delete dados[k]; }
    }
  };
  return dados;
}

test("pede um código de pareamento e devolve o bilhete", async () => {
  responderCom({
    "/v1/auth/device/code": {
      status: 200,
      body: { code: "ABC234", deviceId: "aparelho-1", expiresInSeconds: 300 }
    }
  });

  const ticket = await requestPairingCode();

  assert.equal(ticket.code, "ABC234");
  assert.equal(ticket.deviceId, "aparelho-1");
});

// 202 é "ainda não aprovaram", e não erro. Tratar como falha faria a TV desistir do
// pareamento no primeiro segundo, antes de alguém chegar perto do computador.
test("claim ainda não aprovado devolve null em vez de erro", async () => {
  armazenamentoFalso();
  responderCom({ "/v1/auth/device/claim": { status: 202, body: null } });

  const token = await claimSession({ code: "ABC234", deviceId: "aparelho-1", expiresInSeconds: 300 });

  assert.equal(token, null);
});

test("claim aprovado devolve o token e já o instala", async () => {
  const dados = armazenamentoFalso();
  setCredential({ kind: "cookie" });
  responderCom({ "/v1/auth/device/claim": { status: 200, body: { token: "token-do-aparelho" } } });

  const token = await claimSession({ code: "ABC234", deviceId: "aparelho-1", expiresInSeconds: 300 });

  assert.equal(token, "token-do-aparelho");
  assert.equal(dados["cebola.sessao"], "token-do-aparelho");
  assert.deepEqual(getCredential(), { kind: "bearer", token: "token-do-aparelho" });
});

// Sem isto o app parearia de novo a cada abertura, e o teto de 20 aparelhos da conta se
// esgotaria sozinho em poucas semanas de uso normal.
test("sessão guardada volta a valer na abertura seguinte", async () => {
  armazenamentoFalso({ "cebola.sessao": "token-guardado" });
  setCredential({ kind: "cookie" });

  assert.equal(restoreSession(), true);
  assert.deepEqual(getCredential(), { kind: "bearer", token: "token-guardado" });
});

test("sem sessão guardada, restoreSession avisa que precisa parear", async () => {
  armazenamentoFalso();
  setCredential({ kind: "cookie" });

  assert.equal(restoreSession(), false);
  assert.deepEqual(getCredential(), { kind: "cookie" });
});
