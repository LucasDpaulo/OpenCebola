import assert from "node:assert/strict";
import test from "node:test";
import { HouseholdService, InMemoryHouseholdRepository } from "../src/households/index.js";
import type { HouseholdRepository } from "../src/households/index.js";

const ownerId = "5f6b2f4c-9f1a-4c33-9a2a-3f1f4a2b8c77";

/** Repositório que conta quantas vezes a casa foi realmente procurada no banco. */
function repositorioContado(): { repository: HouseholdRepository; buscas: () => number } {
  const interno = new InMemoryHouseholdRepository();
  let buscas = 0;
  const repository = new Proxy(interno, {
    get(alvo, propriedade, receptor) {
      const valor = Reflect.get(alvo, propriedade, receptor);
      if (propriedade === "findHouseholdByOwnerId" && typeof valor === "function") {
        return (...argumentos: readonly unknown[]) => {
          buscas += 1;
          return (valor as (...a: readonly unknown[]) => unknown).apply(alvo, argumentos);
        };
      }
      return typeof valor === "function" ? (valor as () => unknown).bind(alvo) : valor;
    }
  }) as unknown as HouseholdRepository;
  return { repository, buscas: () => buscas };
}

function relogio(inicio: number) {
  let agora = inicio;
  return {
    now: () => new Date(agora),
    avancar: (ms: number) => {
      agora += ms;
    }
  };
}

test("a casa do dono é procurada uma vez só dentro do TTL", async () => {
  const { repository, buscas } = repositorioContado();
  const tempo = relogio(0);
  const service = new HouseholdService({ repository, now: tempo.now, ownerCacheTtlMs: 60_000 });
  await service.createHousehold({ ownerId, name: "Casa" });
  const antes = buscas();

  const primeira = await service.ensureHouseholdForOwner(ownerId);
  const segunda = await service.ensureHouseholdForOwner(ownerId);
  const terceira = await service.ensureHouseholdForOwner(ownerId);

  assert.equal(primeira.id, segunda.id);
  assert.equal(segunda.id, terceira.id);
  assert.equal(buscas() - antes, 1);
});

test("passado o TTL, a casa é procurada de novo", async () => {
  const { repository, buscas } = repositorioContado();
  const tempo = relogio(0);
  const service = new HouseholdService({ repository, now: tempo.now, ownerCacheTtlMs: 60_000 });
  await service.createHousehold({ ownerId, name: "Casa" });
  const antes = buscas();

  await service.ensureHouseholdForOwner(ownerId);
  tempo.avancar(60_001);
  await service.ensureHouseholdForOwner(ownerId);

  assert.equal(buscas() - antes, 2);
});

test("donos diferentes não compartilham entrada de cache", async () => {
  const { repository } = repositorioContado();
  const outroOwner = "9c1d7e21-4a6b-4f0d-8f2e-6b7a1c3d9e40";
  const tempo = relogio(0);
  const service = new HouseholdService({ repository, now: tempo.now, ownerCacheTtlMs: 60_000 });
  await service.createHousehold({ ownerId, name: "Casa do Lucas" });
  await service.createHousehold({ ownerId: outroOwner, name: "Outra casa" });

  const uma = await service.ensureHouseholdForOwner(ownerId);
  const outra = await service.ensureHouseholdForOwner(outroOwner);

  assert.notEqual(uma.id, outra.id);
});

test("a casa provisionada na primeira chamada já entra no cache", async () => {
  const { repository, buscas } = repositorioContado();
  const tempo = relogio(0);
  const service = new HouseholdService({ repository, now: tempo.now, ownerCacheTtlMs: 60_000 });

  const criada = await service.ensureHouseholdForOwner(ownerId);
  const buscasAposCriar = buscas();
  const relida = await service.ensureHouseholdForOwner(ownerId);

  assert.equal(relida.id, criada.id);
  assert.equal(buscas(), buscasAposCriar);
});

// O cache não pode crescer para sempre: uma entrada por dono autenticado, e nada apagava as
// vencidas — só as substituía. Um processo longo segurava todas as casas que já viu.
test("o cache de casas tem teto e despeja a vencida primeiro", async () => {
  const { repository, buscas } = repositorioContado();
  const tempo = relogio(0);
  const service = new HouseholdService({
    repository,
    now: tempo.now,
    ownerCacheTtlMs: 60_000,
    ownerCacheMaxEntries: 2
  });

  const donos = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333"
  ];
  for (const dono of donos) await service.createHousehold({ ownerId: dono, name: `Casa ${dono}` });

  await service.ensureHouseholdForOwner(donos[0]!);
  await service.ensureHouseholdForOwner(donos[1]!);
  await service.ensureHouseholdForOwner(donos[2]!);

  // Com teto 2, a entrada do primeiro dono já saiu: perguntar por ela volta ao repositório.
  const antes = buscas();
  await service.ensureHouseholdForOwner(donos[0]!);
  assert.equal(buscas() - antes, 1, "o primeiro dono deveria ter sido despejado");

  // E o último a entrar continua lembrado, sem nova busca.
  const depois = buscas();
  await service.ensureHouseholdForOwner(donos[2]!);
  assert.equal(buscas() - depois, 0, "o mais recente deveria continuar em cache");
});
