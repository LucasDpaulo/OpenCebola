import assert from "node:assert/strict";
import test from "node:test";
import { StreamingSessionController, type StreamingEngine, type StreamingSession } from "../app/streaming/streaming-engine.js";

const request = { infoHash: "a".repeat(40), fileIdx: 0, trackers: [] };
const session = (id: string): StreamingSession => ({ id, url: `http://127.0.0.1:8765/${id}`, fileIdx: 0 });
function engine(prepare: StreamingEngine["prepare"], stop: StreamingEngine["stop"]): StreamingEngine {
  return { prepare, stop, capabilities: async () => ({ available: true, backend: "test" }),
    subscribe: () => () => {}, cacheInfo: async () => ({ usedBytes: 0, capacityBytes: 0, protectedBytes: 0 }),
    clearCache: async () => {}, shutdown: async () => {} };
}

test("preparação atrasada é encerrada antes da fonte nova", async () => {
  let finish!: (value: StreamingSession) => void;
  let started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const stopped: string[] = [];
  let calls = 0;
  const controller = new StreamingSessionController(engine(async () => {
    calls++;
    if (calls === 1) { started(); return new Promise(resolve => { finish = resolve; }); }
    assert.deepEqual(stopped, ["old"]);
    return session("new");
  }, async id => { stopped.push(id); }));
  const old = controller.prepare(request);
  const rejected = assert.rejects(old);
  await beginning;
  const next = controller.prepare(request);
  finish(session("old"));
  await rejected;
  assert.equal((await next).id, "new");
  await controller.stop();
  await controller.stop();
  assert.deepEqual(stopped, ["old", "new"]);
});

test("sair durante preparação remove a sessão que chega atrasada", async () => {
  let finish!: (value: StreamingSession) => void;
  let started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const stopped: string[] = [];
  const controller = new StreamingSessionController(engine(async () => {
    started(); return new Promise(resolve => { finish = resolve; });
  }, async id => { stopped.push(id); }));
  const preparing = controller.prepare(request);
  const rejected = assert.rejects(preparing);
  await beginning;
  const stopping = controller.stop();
  finish(session("late"));
  await Promise.all([rejected, stopping]);
  assert.deepEqual(stopped, ["late"]);
});

test("URL externa retornada pela ponte é recusada e sua sessão encerrada", async () => {
  const stopped: string[] = [];
  const controller = new StreamingSessionController(engine(async () => ({ ...session("bad"), url: "https://example.com/video" }), async id => { stopped.push(id); }));
  await assert.rejects(controller.prepare(request), /sessão local inválida/);
  assert.deepEqual(stopped, ["bad"]);
});

test("falha ao encerrar impede nova preparação e permite tentar a limpeza novamente", async () => {
  let calls = 0;
  let fail = true;
  const controller = new StreamingSessionController(engine(async () => { calls++; return session("one"); }, async () => {
    if (fail) throw new Error("cleanup failed");
  }));
  await controller.prepare(request);
  await assert.rejects(controller.prepare(request), /cleanup failed/);
  assert.equal(calls, 1);
  fail = false;
  await controller.stop();
});

test("cleanup do player antigo não encerra uma sessão nova", async () => {
  const stopped: string[] = [];
  let id = 0;
  const controller = new StreamingSessionController(engine(async () => session(String(++id)), async value => { stopped.push(value); }));
  const first = await controller.prepare(request);
  const second = await controller.prepare(request);
  await controller.stopSession(first.id);
  assert.deepEqual(stopped, [first.id]);
  await controller.stopSession(second.id);
  assert.deepEqual(stopped, [first.id, second.id]);
});
