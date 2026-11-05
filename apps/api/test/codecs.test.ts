import assert from "node:assert/strict";
import test from "node:test";
import { MULTICHANNEL_HINT_PATTERN } from "@cebola/contracts/codecs";

test("pista multicanal reconhece separador por ponto sem confundir versão ou nome de codec", () => {
  for (const value of ["Ita Eng Spa 5.1", "WEB-DL.5.1.x264", "REMUX.7.1.HEVC"]) {
    assert.equal(MULTICHANNEL_HINT_PATTERN.test(value), true, value);
  }
  for (const value of ["Filme.v5.1.x264", "DDP5.1", "temporada15.1"]) {
    assert.equal(MULTICHANNEL_HINT_PATTERN.test(value), false, value);
  }
});
