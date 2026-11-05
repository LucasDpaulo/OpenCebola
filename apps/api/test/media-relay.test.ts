import assert from "node:assert/strict";
import test from "node:test";
import { MediaRelayError, RealDebridMediaRelay } from "../src/stremio/media-relay.js";
import { pinnedMediaFetch } from "../src/stremio/safe-http.js";
import { StremioIntegrationError } from "../src/stremio/types.js";

test("relay entrega Range pela VM sem expor a URL Real-Debrid no ticket", async () => {
  const upstreamUrl = "https://1.1.1.1/private-real-debrid-link";
  let receivedRange: string | null = null;
  const relay = new RealDebridMediaRelay({
    fetch: async (input, init) => {
      assert.equal(String(input), upstreamUrl);
      receivedRange = new Headers(init?.headers).get("range");
      return new Response(new Uint8Array([1]), {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "1",
          "content-range": "bytes 0-0/1000",
          "content-type": "video/mp4"
        }
      });
    }
  });

  const ticket = relay.issue("household-a", upstreamUrl);
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ticket.includes("real-debrid"), false);
  const response = await relay.open(ticket, "household-a", "bytes=0-0");
  assert.equal(response.status, 206);
  assert.equal(receivedRange, "bytes=0-0");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1]));
});

test("relay isola tickets por casa, expira e rejeita Range ambíguo", async () => {
  let now = 1_000;
  const relay = new RealDebridMediaRelay({
    now: () => now,
    ttlMs: 100,
    fetch: async () => new Response(new Uint8Array([1]))
  });
  const ticket = relay.issue("household-a", "https://1.1.1.1/video.mp4");

  await assert.rejects(() => relay.open(ticket, "household-b", undefined), (error: unknown) =>
    error instanceof MediaRelayError && error.code === "NOT_FOUND"
  );
  await assert.rejects(() => relay.open(ticket, "household-a", "bytes=0-1,4-5"), (error: unknown) =>
    error instanceof MediaRelayError && error.code === "NOT_FOUND"
  );
  now = 1_101;
  await assert.rejects(() => relay.open(ticket, "household-a", undefined), (error: unknown) =>
    error instanceof MediaRelayError && error.code === "NOT_FOUND"
  );
});

test("relay segue redirecionamento HTTPS público sem expor o destino ao navegador", async () => {
  const calls: string[] = [];
  const relay = new RealDebridMediaRelay({
    fetch: async (input) => {
      calls.push(String(input));
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://1.0.0.1/video.mp4" } })
        : new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "video/mp4" } });
    }
  });
  const ticket = relay.issue("household-a", "https://1.1.1.1/resolve");
  const response = await relay.open(ticket, "household-a", undefined);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["https://1.1.1.1/resolve", "https://1.0.0.1/video.mp4"]);
});

// Regressão de SSRF: o relay usava o fetch global depois de validar a URL. O fetch resolve o DNS
// outra vez, então um host com TTL 0 podia responder um IP público na validação e um privado na
// conexão (DNS rebinding) — nesta topologia, o serviço de metadados da instância Oracle, com a
// resposta voltando pelo relay até o navegador. O default agora fixa a conexão no IP validado.
test("pinnedMediaFetch recusa endereços fora da faixa pública, incluindo o metadata da nuvem", async () => {
  for (const alvo of [
    "https://169.254.169.254/opc/v2/instance/",
    "https://127.0.0.1/video.mp4",
    "https://10.0.0.207/video.mp4",
    "https://[::1]/video.mp4"
  ]) {
    await assert.rejects(() => pinnedMediaFetch(alvo), (error: unknown) =>
      error instanceof StremioIntegrationError && error.code === "UNSAFE_ADDON",
      `deveria recusar ${alvo}`
    );
  }
});
