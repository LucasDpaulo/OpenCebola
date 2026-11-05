import assert from "node:assert/strict";
import test from "node:test";
import {
  PIN_ARGON2_OPTIONS,
  PIN_ERROR_MESSAGE,
  PinError,
  PinService
} from "../src/profiles/index.js";

const pepper = new Uint8Array(32).fill(0x42);

test("gera hash Argon2id real sem incluir o PIN", async () => {
  const service = new PinService({ pepper });

  const first = await service.hashPin("1234");
  const second = await service.hashPin("1234");

  assert.match(first, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(first.includes("1234"), false);
  assert.notEqual(first, second, "cada hash deve receber salt aleatório");
  assert.equal(await service.verifyPin("1234", first), true);
});

test("aceita somente quatro dígitos ASCII", async () => {
  const service = new PinService({ pepper });
  const invalidPins = ["123", "12345", "12a4", "１２３４", " 1234", "1234 "];

  for (const pin of invalidPins) {
    await assert.rejects(
      () => service.hashPin(pin),
      (error: unknown) => error instanceof PinError &&
        error.message === PIN_ERROR_MESSAGE &&
        !error.message.includes(pin)
    );
  }
});

test("PIN incorreto, formato inválido e hash corrompido têm resultado neutro", async () => {
  const service = new PinService({ pepper });
  const encodedHash = await service.hashPin("1234");

  assert.equal(await service.verifyPin("9999", encodedHash), false);
  assert.equal(await service.verifyPin("999", encodedHash), false);
  assert.equal(await service.verifyPin("1234", "$argon2id$invalid"), false);

  for (const [pin, hash] of [
    ["9999", encodedHash],
    ["1234", "$argon2id$invalid"]
  ] as const) {
    await assert.rejects(
      () => service.assertPin(pin, hash),
      (error: unknown) => error instanceof PinError &&
        error.message === PIN_ERROR_MESSAGE
    );
  }
});

test("pepper é obrigatório e impede verificação com segredo diferente", async () => {
  assert.throws(
    () => new PinService({ pepper: new Uint8Array(16) }),
    TypeError
  );

  const firstService = new PinService({ pepper });
  const otherService = new PinService({ pepper: new Uint8Array(32).fill(0x24) });
  const encodedHash = await firstService.hashPin("1234");

  assert.equal(await otherService.verifyPin("1234", encodedHash), false);
});

test("parâmetros limitam uma operação a uma thread e memória moderada", () => {
  assert.deepEqual(PIN_ARGON2_OPTIONS, {
    algorithm: 2,
    version: 1,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32
  });
});
