import assert from "node:assert/strict";
import test from "node:test";
import { sourceReleaseTags } from "../app/player/source-tags";

test("remux UHD com Dolby Vision e TrueHD", () => {
  assert.deepEqual(
    sourceReleaseTags("The.Godfather.1972.REPACK.UHD.BluRay.2160p.TrueHD.5.1.DV.HEVC.REMUX-FraMeSToR"),
    ["REMUX", "BluRay", "Dolby Vision", "HEVC", "Dolby TrueHD", "5.1"]
  );
});

test("WEB-DL com DDP, Atmos, DV e HDR10", () => {
  assert.deepEqual(
    sourceReleaseTags("Movie.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR10.H.265-FLUX"),
    ["WEB-DL", "Dolby Vision", "HDR10", "HEVC", "Dolby Atmos", "Dolby Digital Plus", "5.1"]
  );
});

test("WEBRip x264 AAC 2.0", () => {
  assert.deepEqual(sourceReleaseTags("Show.S01E01.1080p.WEBRip.x264.AAC2.0"), ["WEBRip", "AAC", "2.0"]);
});

test("sem pistas e sem falso positivo", () => {
  assert.deepEqual(sourceReleaseTags("Some Movie 1080p"), []);
  assert.deepEqual(sourceReleaseTags("Addams.Family.DVDRip.ADD"), ["DVDRip"]);
  assert.deepEqual(sourceReleaseTags("Movie.ATMOS.DD5.1"), ["Dolby Atmos", "Dolby Digital", "5.1"]);
});
