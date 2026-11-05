import assert from "node:assert/strict";
import test from "node:test";
import { followRedirects, redirectTarget, validatePublicHttpsUrl } from "../src/stremio/safe-http.js";
import { StremioIntegrationError } from "../src/stremio/types.js";

// Cobre o redirect seguro de getSafeJson (bug de produção: Cinemeta responde 307 antes do JSON
// e a política antiga tratava qualquer status != 200 como UPSTREAM_UNAVAILABLE, derrubando o
// catálogo inteiro). validatePublicHttpsUrl exige IP público, então um servidor HTTPS local em
// 127.0.0.1 nunca passaria da política — por isso nenhum teste aqui abre socket.

test("redirectTarget aceita os 5 status de redirect e resolve Location absoluto", () => {
  const atual = new URL("https://v3-cinemeta.strem.io/catalog/movie/top.json");
  for (const status of [301, 302, 303, 307, 308]) {
    const destino = redirectTarget(status, "https://cinemeta-catalogs.strem.io/top/catalog/movie/top.json", atual);
    assert.equal(destino?.href, "https://cinemeta-catalogs.strem.io/top/catalog/movie/top.json");
  }
});

test("redirectTarget resolve Location relativo contra a URL atual", () => {
  const atual = new URL("https://v3-cinemeta.strem.io/catalog/movie/top.json");
  const destino = redirectTarget(307, "/top/catalog/movie/top.json", atual);
  assert.equal(destino?.href, "https://v3-cinemeta.strem.io/top/catalog/movie/top.json");
});

test("redirectTarget devolve null para status que não é redirect, mesmo com Location presente", () => {
  const atual = new URL("https://addon.example/catalog/movie/top.json");
  for (const status of [200, 404, 500]) {
    assert.equal(redirectTarget(status, "https://outro.example/x", atual), null);
  }
});

test("redirectTarget sem Location num status de redirect vira UPSTREAM_UNAVAILABLE", () => {
  const atual = new URL("https://addon.example/catalog/movie/top.json");
  assert.throws(
    () => redirectTarget(307, undefined, atual),
    (error: unknown) => error instanceof StremioIntegrationError && error.code === "UPSTREAM_UNAVAILABLE"
  );
});

test("redirectTarget com Location não parseável num status de redirect vira UPSTREAM_UNAVAILABLE", () => {
  const atual = new URL("https://addon.example/catalog/movie/top.json");
  assert.throws(
    () => redirectTarget(307, "https://[", atual),
    (error: unknown) => error instanceof StremioIntegrationError && error.code === "UPSTREAM_UNAVAILABLE"
  );
});

test("followRedirects não chama revalidate quando a primeira resposta já é o json final", async () => {
  const inicio = new URL("https://hop0.example/x");
  let chamadasRevalidate = 0;
  const valor = await followRedirects(
    inicio,
    async () => ({ kind: "json" as const, value: { metas: [] } }),
    async (url) => {
      chamadasRevalidate += 1;
      return url;
    }
  );
  assert.deepEqual(valor, { metas: [] });
  assert.equal(chamadasRevalidate, 0);
});

test("followRedirects também encerra com texto de legenda sem revalidar", async () => {
  let chamadasRevalidate = 0;
  const valor = await followRedirects(
    new URL("https://legendas.example/subtitle.srt"),
    async () => ({ kind: "text" as const, value: "1\n00:00:01,000 --> 00:00:02,000\nOlá" }),
    async (url) => { chamadasRevalidate += 1; return url; }
  );
  assert.match(String(valor), /Olá/);
  assert.equal(chamadasRevalidate, 0);
});

test("followRedirects segue até o limite de 3 saltos e retorna o json do salto final, revalidando cada destino", async () => {
  const saltos = [0, 1, 2, 3].map((n) => new URL(`https://hop${n}.example/x`));
  const chamadasFetch: string[] = [];
  const chamadasRevalidate: string[] = [];
  const valor = await followRedirects(
    saltos[0],
    async (url) => {
      chamadasFetch.push(url.href);
      const indice = saltos.findIndex((candidato) => candidato.href === url.href);
      return indice < 3
        ? { kind: "redirect" as const, location: saltos[indice + 1] }
        : { kind: "json" as const, value: { ok: true } };
    },
    async (url) => {
      chamadasRevalidate.push(url.href);
      return url;
    }
  );
  assert.deepEqual(valor, { ok: true });
  assert.deepEqual(chamadasFetch, saltos.map((url) => url.href));
  assert.deepEqual(chamadasRevalidate, saltos.slice(1).map((url) => url.href));
});

test("followRedirects estoura o limite de saltos e falha com UPSTREAM_UNAVAILABLE sem seguir o 4º redirect", async () => {
  const inicio = new URL("https://hop0.example/x");
  let chamadasFetch = 0;
  let chamadasRevalidate = 0;
  await assert.rejects(
    followRedirects(
      inicio,
      async () => {
        chamadasFetch += 1;
        return { kind: "redirect" as const, location: new URL(`https://hop${chamadasFetch}.example/x`) };
      },
      async (url) => {
        chamadasRevalidate += 1;
        return url;
      }
    ),
    (error: unknown) => error instanceof StremioIntegrationError && error.code === "UPSTREAM_UNAVAILABLE"
  );
  assert.equal(chamadasFetch, 4); // salto inicial + 3 redirects seguidos, no limite
  assert.equal(chamadasRevalidate, 3); // o 4º redirect nem chega a ser revalidado: já estourou
});

test("followRedirects propaga a rejeição da política e não tenta seguir o redirect de novo", async () => {
  const inicio = new URL("https://hop0.example/x");
  let chamadasFetch = 0;
  await assert.rejects(
    followRedirects(
      inicio,
      async () => {
        chamadasFetch += 1;
        return { kind: "redirect" as const, location: new URL("https://10.0.0.1/interno.json") };
      },
      async () => {
        throw new StremioIntegrationError("UNSAFE_ADDON");
      }
    ),
    (error: unknown) => error instanceof StremioIntegrationError && error.code === "UNSAFE_ADDON"
  );
  assert.equal(chamadasFetch, 1);
});

test("cenário real do Cinemeta: redirect 307 cross-host segue com a política real e chega ao json", async () => {
  // IPs literais evitam DNS, mesma técnica de stremio-security.test.ts.
  const inicio = new URL("https://1.1.1.1/catalog/movie/top.json");
  const alvo = new URL("https://1.0.0.1/top/catalog/movie/top.json");
  const saltos: string[] = [];
  const valor = await followRedirects(
    inicio,
    async (url) => {
      saltos.push(url.href);
      return url.href === inicio.href
        ? { kind: "redirect" as const, location: redirectTarget(307, alvo.href, url)! }
        : { kind: "json" as const, value: { metas: [] } };
    },
    (url) => validatePublicHttpsUrl(url.href) // política real do primeiro salto, sem dublê
  );
  assert.deepEqual(valor, { metas: [] });
  assert.deepEqual(saltos, [inicio.href, alvo.href]);
});

test("redirect para IP privado é recusado pela política real: redirect não vira bypass de SSRF", async () => {
  const inicio = new URL("https://1.1.1.1/catalog/movie/top.json");
  await assert.rejects(
    followRedirects(
      inicio,
      async () => ({ kind: "redirect" as const, location: new URL("https://10.0.0.1/interno.json") }),
      (url) => validatePublicHttpsUrl(url.href)
    ),
    (error: unknown) => error instanceof StremioIntegrationError && error.code === "UNSAFE_ADDON"
  );
});

test("política de rede recusa alvo de redirect fora do HTTPS público: downgrade, IP privado, IPv6 loopback, porta alternativa e credenciais", async () => {
  // Estes valores representam o Location já resolvido de um redirect: a mesma
  // validatePublicHttpsUrl do primeiro salto é reaplicada em cada destino (ver getSafeJson).
  await assert.rejects(() => validatePublicHttpsUrl("http://1.1.1.1/top.json"));
  await assert.rejects(() => validatePublicHttpsUrl("https://10.0.0.1/top.json"));
  await assert.rejects(() => validatePublicHttpsUrl("https://[::1]/top.json"));
  await assert.rejects(() => validatePublicHttpsUrl("https://1.1.1.1:8443/top.json"));
  await assert.rejects(() => validatePublicHttpsUrl("https://usuario:senha@1.1.1.1/top.json"));
});
