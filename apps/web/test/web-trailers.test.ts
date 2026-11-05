import assert from "node:assert/strict";
import test from "node:test";
import { webTrailersAllowed } from "../app/use-web-trailers";

test("trailers só são habilitados na web fora do modo TV", () => {
  assert.equal(webTrailersAllowed(false, false), true);
  assert.equal(webTrailersAllowed(true, false), false);
  assert.equal(webTrailersAllowed(true, true), false);
  assert.equal(webTrailersAllowed(false, true), false);
});
