import assert from "node:assert/strict";
import test from "node:test";
import { loadWithPool } from "../app/loading-pool.js";

function adiavel<T>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<T>((ok, falha) => {
    resolver = ok;
    rejeitar = falha;
  });
  return { promessa, resolver, rejeitar };
}

test("nunca passa do teto de simultâneas", async () => {
  let emVoo = 0;
  let pico = 0;
  const adiaveis = Array.from({ length: 10 }, () => adiavel<string>());

  const corrida = loadWithPool({
    items: adiaveis,
    limit: 3,
    load: async (item) => {
      emVoo += 1;
      pico = Math.max(pico, emVoo);
      try {
        return await item.promessa;
      } finally {
        emVoo -= 1;
      }
    },
    onProgress: () => {}
  });

  // Só as três primeiras podem ter partido.
  await Promise.resolve();
  assert.equal(pico, 3);

  for (const item of adiaveis) item.resolver("pronto");
  await corrida;
  assert.equal(pico, 3);
});

test("resultado aparece na posição original, mesmo chegando fora de ordem", async () => {
  const adiaveis = Array.from({ length: 3 }, () => adiavel<string>());
  const instantaneos: (readonly (string | null)[])[] = [];

  const corrida = loadWithPool({
    items: adiaveis,
    limit: 3,
    load: (item) => item.promessa,
    onProgress: (resultados) => instantaneos.push(resultados)
  });

  adiaveis[2]!.resolver("terceiro");
  await new Promise((pronto) => setImmediate(pronto));
  adiaveis[0]!.resolver("primeiro");
  await new Promise((pronto) => setImmediate(pronto));
  adiaveis[1]!.resolver("segundo");
  await corrida;

  assert.deepEqual(instantaneos[0], [null, null, "terceiro"]);
  assert.deepEqual(instantaneos.at(-1), ["primeiro", "segundo", "terceiro"]);
});

test("cada resultado é publicado assim que chega, sem esperar o lote", async () => {
  const adiaveis = Array.from({ length: 4 }, () => adiavel<string>());
  let publicacoes = 0;

  const corrida = loadWithPool({
    items: adiaveis,
    limit: 4,
    load: (item) => item.promessa,
    onProgress: () => { publicacoes += 1; }
  });

  adiaveis[0]!.resolver("a");
  await new Promise((pronto) => setImmediate(pronto));
  assert.equal(publicacoes, 1);

  for (const item of adiaveis.slice(1)) item.resolver("x");
  await corrida;
  assert.equal(publicacoes, 4);
});

test("uma fonte que falha não derruba as outras", async () => {
  const resultados = await recolher([
    async () => "boa",
    async () => { throw new Error("fonte fora do ar"); },
    async () => "outra boa"
  ]);

  assert.deepEqual(resultados, ["boa", null, "outra boa"]);
});

test("para de puxar trabalho quando pedem para parar", async () => {
  let carregados = 0;
  let parar = false;

  await loadWithPool({
    items: [1, 2, 3, 4, 5, 6],
    limit: 1,
    load: async (item) => {
      carregados += 1;
      if (item === 2) parar = true;
      return item;
    },
    onProgress: () => {},
    shouldStop: () => parar
  });

  assert.equal(carregados, 2);
});

test("lista vazia não trava nem chama nada", async () => {
  let chamou = false;
  await loadWithPool({
    items: [],
    limit: 4,
    load: async () => { chamou = true; return 1; },
    onProgress: () => { chamou = true; }
  });
  assert.equal(chamou, false);
});

test("limite maior que a lista não cria trabalhador ocioso demais", async () => {
  const resultados = await recolher([async () => "só", async () => "duas"], 10);
  assert.deepEqual(resultados, ["só", "duas"]);
});

async function recolher<R>(
  tarefas: readonly (() => Promise<R>)[],
  limite = 3
): Promise<readonly (R | null)[]> {
  let ultimo: readonly (R | null)[] = [];
  await loadWithPool({
    items: tarefas,
    limit: limite,
    load: (tarefa) => tarefa(),
    onProgress: (resultados) => { ultimo = resultados; }
  });
  return ultimo;
}

// A garantia que o código em lotes tinha e o pool tinha perdido: publicar SEMPRE, mesmo quando
// tudo falha. Sem isso a tela fica exibindo o resultado de uma carga anterior, sem sinal nenhum.
test("publica mesmo quando todas as fontes falham", async () => {
  let publicacoes = 0;
  let ultimo: readonly (string | null)[] = ["ainda não mexeram aqui"];

  await loadWithPool({
    items: [1, 2, 3],
    limit: 2,
    load: async () => { throw new Error("fonte fora do ar"); },
    onProgress: (resultados) => { publicacoes += 1; ultimo = resultados as readonly (string | null)[]; }
  });

  assert.equal(publicacoes, 3);
  assert.deepEqual(ultimo, [null, null, null]);
});

// Entregar o array vivo faria o React descartar o render por igualdade de referência, e a lista
// guardada pelo consumidor mudaria sozinha depois.
test("cada publicação é uma cópia, não o array vivo", async () => {
  const recebidos: (readonly (number | null)[])[] = [];

  await loadWithPool({
    items: [1, 2, 3],
    limit: 1,
    load: async (item) => item,
    onProgress: (resultados) => recebidos.push(resultados)
  });

  assert.equal(recebidos.length, 3);
  assert.notEqual(recebidos[0], recebidos[1]);
  assert.deepEqual(recebidos[0], [1, null, null]);
  assert.deepEqual(recebidos[2], [1, 2, 3]);
});

// Um limite computado que chegue zerado não pode virar "carregou nada, deu tudo certo".
test("limite zero ou negativo vira sequencial, nunca nenhum trabalhador", async () => {
  for (const limite of [0, -3]) {
    const resultados = await recolher([async () => "a", async () => "b"], limite);
    assert.deepEqual(resultados, ["a", "b"], `limite ${limite}`);
  }
});
