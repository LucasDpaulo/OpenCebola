import assert from "node:assert/strict";
import test from "node:test";
import { splitSubtitleLabel } from "../app/player/subtitle-label";

test("separa idioma e detalhes no primeiro ' · '", () => {
  assert.deepEqual(
    splitSubtitleLabel("Português (Brasil) 2 · One.Piece.S14E1068.srt · OpenSubtitles v3"),
    { language: "Português (Brasil)", details: "One.Piece.S14E1068.srt · OpenSubtitles v3" }
  );
});

test("sem detalhes devolve só o idioma", () => {
  assert.deepEqual(splitSubtitleLabel("Inglês"), { language: "Inglês", details: "" });
  assert.deepEqual(splitSubtitleLabel("Inglês 3"), { language: "Inglês", details: "" });
});
