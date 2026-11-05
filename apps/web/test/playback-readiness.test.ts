import assert from "node:assert/strict";
import test from "node:test";
import { tracksPreparedFor } from "../app/player/playback-readiness";
import { playbackPreparationKey } from "../app/player/playback-preparation";

test("pulos só são liberados pela preparação do vídeo, fonte e motor atuais", () => {
  const player = {};
  const prepared = { key: playbackPreparationKey("ep1", "source1"), player };
  assert.equal(tracksPreparedFor(null, "ep1", "source1", player), false);
  assert.equal(tracksPreparedFor(prepared, "ep1", "source1", player), true);
  assert.equal(tracksPreparedFor(prepared, "ep2", "source1", player), false);
  assert.equal(tracksPreparedFor(prepared, "ep1", "source2", player), false);
  assert.equal(tracksPreparedFor(prepared, "ep1", "source1", {}), false);
  assert.equal(tracksPreparedFor(prepared, "ep1", null, player), false);
});
