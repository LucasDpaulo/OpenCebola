import assert from "node:assert/strict";
import test from "node:test";
import { releaseGroupOf, retrySourceAfterFailure } from "../app/player/playback-failure-policy.js";

const sources = [{ id: "first" }, { id: "second" }];

test("fonte escolhida manualmente falha sem iniciar outra análise automática", () => {
  const next = retrySourceAfterFailure(sources, new Set(["first"]), "manual", false, (remaining) => remaining[0] ?? null);
  assert.equal(next, null);
});

test("fonte aberta por Continuar que falha tenta a próxima uma vez em vez de voltar à lista", () => {
  const next = retrySourceAfterFailure(sources, new Set(["first"]), "requested", false, (remaining) => remaining[0] ?? null);
  assert.deepEqual(next, { id: "second" });
  assert.equal(retrySourceAfterFailure(sources, new Set(["first"]), "requested", true, (remaining) => remaining[0] ?? null), null);
});

test("fonte automática pode tentar a próxima uma vez, sem repetir a que falhou", () => {
  const next = retrySourceAfterFailure(sources, new Set(["first"]), "automatic", false, (remaining) => remaining[0] ?? null);
  assert.deepEqual(next, { id: "second" });
  assert.equal(retrySourceAfterFailure(sources, new Set(["first"]), "automatic", true, (remaining) => remaining[0] ?? null), null);
});

test("grupo do release: colchete de anime ou sufixo do nome", () => {
  assert.equal(releaseGroupOf("[SubsPlease] One Piece - 1122 (1080p) [ABCD1234].mkv"), "subsplease");
  assert.equal(releaseGroupOf("The.Godfather.1972.1080p.BluRay.x264-CtrlHD.mkv"), "ctrlhd");
  assert.equal(releaseGroupOf("Filme sem grupo 1080p"), null);
});
