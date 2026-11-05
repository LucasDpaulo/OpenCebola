import assert from "node:assert/strict";
import test from "node:test";
import { collectWithin, resolveWithin } from "../src/stremio/official-subtitles.js";

test("fallback oficial tem prazo e não segura a resposta quando o provedor trava", async () => {
  const never = new Promise<string[]>(() => undefined);
  const result = await resolveWithin(never, 5, []);
  assert.deepEqual(result, []);
});

test("timeout preserva legendas da consulta que respondeu antes da outra travar", async () => {
  const slow = new Promise<readonly string[]>(() => undefined);
  const result = await collectWithin([Promise.resolve(["pronta"]), slow], 5);
  assert.deepEqual(result, ["pronta"]);
});

test("resultados conservam prioridade do ID original mesmo se o alias responder antes", async () => {
  let finishOriginal!: (value: readonly string[]) => void;
  const original = new Promise<readonly string[]>((resolve) => { finishOriginal = resolve; });
  const pending = collectWithin([original, Promise.resolve(["alias"])], 100);
  await Promise.resolve();
  finishOriginal(["original"]);
  assert.deepEqual(await pending, ["original", "alias"]);
});
