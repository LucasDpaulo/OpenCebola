import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError, CachingAuthProvider } from "../src/auth/index.js";
import type { AuthProvider, AuthResult, AuthSession } from "../src/auth/index.js";

const userId = "6a3f1d90-2c4b-4b8a-9f0e-51c7d2a8b311";

function sessionFor(profileId: string | null): AuthSession {
  return {
    user: { id: userId, email: "lucas@example.com" },
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    activeProfileId: profileId
  };
}

/** Provedor de mentira que conta quantas vezes cada porta foi realmente atravessada. */
class ContandoProvider implements AuthProvider {
  verificacoes = 0;
  revogacoes = 0;
  perfilAtivo: string | null = null;
  tokenValido = "token-bom";
  /** Quando presente, a verificação fica pendurada até ser resolvida à mão. */
  segurarVerificacao: { liberar: () => void; promessa: Promise<void> } | null = null;

  async signInWithPassword(): Promise<AuthResult> {
    throw new Error("não usado neste teste");
  }
  async issueSessionForUser(): Promise<AuthResult> {
    throw new Error("não usado neste teste");
  }
  async verifySession(sessionToken: string): Promise<AuthSession> {
    this.verificacoes += 1;
    // O provedor real lê o banco AGORA e responde depois. É por isso que uma revogação que
    // chega no meio do caminho não faz esta resposta falhar: ela já foi decidida.
    const valeAgora = sessionToken === this.tokenValido;
    const perfilNoMomentoDaPergunta = this.perfilAtivo;
    if (this.segurarVerificacao) await this.segurarVerificacao.promessa;
    if (!valeAgora) throw new AuthenticationError();
    return sessionFor(perfilNoMomentoDaPergunta);
  }
  async setActiveProfile(_token: string, profileId: string | null): Promise<AuthSession> {
    this.perfilAtivo = profileId;
    return sessionFor(profileId);
  }
  async revokeSession(): Promise<void> {
    this.revogacoes += 1;
    this.tokenValido = "";
  }
}

function relogio(inicio: number) {
  let agora = inicio;
  return {
    now: () => agora,
    avancar: (ms: number) => {
      agora += ms;
    }
  };
}

test("verificações repetidas dentro do TTL custam uma única ida ao provedor", async () => {
  const interno = new ContandoProvider();
  const tempo = relogio(0);
  const provider = new CachingAuthProvider({ inner: interno, ttlMs: 30_000, now: tempo.now });

  await provider.verifySession("token-bom");
  await provider.verifySession("token-bom");
  await provider.verifySession("token-bom");

  assert.equal(interno.verificacoes, 1);
});

test("passado o TTL, a sessão é verificada de novo", async () => {
  const interno = new ContandoProvider();
  const tempo = relogio(0);
  const provider = new CachingAuthProvider({ inner: interno, ttlMs: 30_000, now: tempo.now });

  await provider.verifySession("token-bom");
  tempo.avancar(30_001);
  await provider.verifySession("token-bom");

  assert.equal(interno.verificacoes, 2);
});

test("revogar a sessão descarta o cache na hora, sem esperar o TTL", async () => {
  const interno = new ContandoProvider();
  const tempo = relogio(0);
  const provider = new CachingAuthProvider({ inner: interno, ttlMs: 30_000, now: tempo.now });

  await provider.verifySession("token-bom");
  await provider.revokeSession("token-bom");

  await assert.rejects(() => provider.verifySession("token-bom"), AuthenticationError);
  assert.equal(interno.revogacoes, 1);
});

test("trocar de perfil é visível na verificação seguinte", async () => {
  const interno = new ContandoProvider();
  const tempo = relogio(0);
  const provider = new CachingAuthProvider({ inner: interno, ttlMs: 30_000, now: tempo.now });

  const antes = await provider.verifySession("token-bom");
  assert.equal(antes.activeProfileId, null);

  await provider.setActiveProfile("token-bom", "perfil-2");
  const depois = await provider.verifySession("token-bom");

  assert.equal(depois.activeProfileId, "perfil-2");
});

test("falha de autenticação não fica em cache", async () => {
  const interno = new ContandoProvider();
  const tempo = relogio(0);
  const provider = new CachingAuthProvider({ inner: interno, ttlMs: 30_000, now: tempo.now });

  await assert.rejects(() => provider.verifySession("token-ruim"), AuthenticationError);
  await assert.rejects(() => provider.verifySession("token-ruim"), AuthenticationError);

  assert.equal(interno.verificacoes, 2);
});

test("tokens diferentes não se confundem no cache", async () => {
  const interno = new ContandoProvider();
  const tempo = relogio(0);
  const provider = new CachingAuthProvider({ inner: interno, ttlMs: 30_000, now: tempo.now });

  await provider.verifySession("token-bom");
  await assert.rejects(() => provider.verifySession("outro-token"), AuthenticationError);

  assert.equal(interno.verificacoes, 2);
});

function segurar() {
  let liberar!: () => void;
  const promessa = new Promise<void>((pronto) => { liberar = () => pronto(); });
  return { liberar, promessa };
}

// A garantia que o comentário do arquivo promete, sob concorrência. Abrir a home deixa várias
// verificações no ar; se alguém sair nesse instante, a resposta que ainda estava voando não
// pode ressuscitar a sessão morta no cache.
test("verificação em voo NÃO ressuscita sessão revogada no meio do caminho", async () => {
  const interno = new ContandoProvider();
  const tempo = relogio(0);
  const provider = new CachingAuthProvider({ inner: interno, ttlMs: 30_000, now: tempo.now });

  interno.segurarVerificacao = segurar();
  const emVoo = provider.verifySession("token-bom");

  await provider.revokeSession("token-bom");
  interno.segurarVerificacao.liberar();
  await emVoo.catch(() => undefined);

  await assert.rejects(() => provider.verifySession("token-bom"), AuthenticationError);
});

// Mesmo mecanismo, outro estrago: o usuário troca de perfil e é jogado de volta para /perfis
// porque uma verificação antiga devolveu o perfil velho por cima do novo.
test("verificação em voo NÃO desfaz a troca de perfil", async () => {
  const interno = new ContandoProvider();
  const tempo = relogio(0);
  const provider = new CachingAuthProvider({ inner: interno, ttlMs: 30_000, now: tempo.now });

  interno.segurarVerificacao = segurar();
  const emVoo = provider.verifySession("token-bom");

  await provider.setActiveProfile("token-bom", "perfil-2");
  interno.segurarVerificacao.liberar();
  await emVoo;

  const depois = await provider.verifySession("token-bom");
  assert.equal(depois.activeProfileId, "perfil-2");
});

// O TTL do cache não pode passar por cima do fim da sessão de verdade.
test("sessão que expirou não é servida do cache", async () => {
  const interno = new ContandoProvider();
  const tempo = relogio(new Date("2026-08-31T23:59:50.000Z").getTime());
  const provider = new CachingAuthProvider({ inner: interno, ttlMs: 30_000, now: tempo.now });

  // sessionFor devolve expiresAt em 2026-09-01T00:00:00Z, ou seja, 10 s à frente.
  await provider.verifySession("token-bom");
  assert.equal(interno.verificacoes, 1);

  tempo.avancar(11_000);
  await provider.verifySession("token-bom");

  assert.equal(interno.verificacoes, 2);
});
