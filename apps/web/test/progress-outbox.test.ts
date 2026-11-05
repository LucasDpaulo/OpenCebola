import assert from "node:assert/strict";
import test from "node:test";
import { pendingProgress, rememberProgress, forgetProgress } from "../app/progress/outbox.js";
import { sendProgress, retryPendingProgress } from "../app/progress/client.js";
import { setCredential } from "../app/api-client.js";

function withStorage(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  } });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}
const body = (position: number, observedAt: string, profileId = "profile-a") => JSON.stringify({
  mediaId: "tt1", videoId: "tt1", positionSeconds: position, durationSeconds: 1000,
  expectedProfileId: profileId, observedAt
});

test("fila preserva conclusão e última posição da revisão, isoladas por perfil", () => {
  const restore = withStorage();
  try {
    const finished = body(950, "2026-10-15T10:00:00.000Z");
    const replay = body(120, "2026-10-15T11:00:00.000Z");
    const latest = body(180, "2026-10-15T11:01:00.000Z");
    rememberProgress("profile-a", finished);
    rememberProgress("profile-a", replay);
    rememberProgress("profile-a", latest);
    rememberProgress("profile-a", replay); // reenvio tardio não substitui a pendência nova
    assert.deepEqual(pendingProgress("profile-a"), [finished, latest]);
    assert.deepEqual(pendingProgress("profile-b"), []);
    forgetProgress("profile-a", replay); // resposta antiga não apaga a pendência nova
    assert.deepEqual(pendingProgress("profile-a"), [finished, latest]);
    forgetProgress("profile-a", finished);
    forgetProgress("profile-a", latest);
    assert.deepEqual(pendingProgress("profile-a"), []);
  } finally { restore(); }
});

test("falha persiste a gravação e reconexão reenvia o mesmo instante e perfil", async () => {
  const restore = withStorage();
  const originalFetch = globalThis.fetch;
  try {
    setCredential({ kind: "cookie" });
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    const payload = body(180, "2026-10-15T11:01:00.000Z");
    assert.equal(await sendProgress(payload, { profileId: "profile-a" }), false);
    assert.deepEqual(pendingProgress("profile-a"), [payload]);
    const calls: string[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      calls.push(String(init.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await retryPendingProgress("profile-b");
    assert.equal(calls.length, 0);
    await retryPendingProgress("profile-a");
    assert.deepEqual(calls, [payload]);
    assert.deepEqual(pendingProgress("profile-a"), []);
  } finally { restore(); globalThis.fetch = originalFetch; }
});

test("storage bloqueado não derruba o player", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("bloqueado"); } });
  try {
    rememberProgress("profile-a", body(120, "2026-10-15T11:00:00Z"));
    assert.deepEqual(pendingProgress("profile-a"), []);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
