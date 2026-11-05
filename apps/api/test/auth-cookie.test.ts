import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_COOKIE_NAME,
  readSessionToken,
  serializeExpiredSessionCookie,
  serializeSessionCookie
} from "../src/auth/index.js";

test("cookie de sessão aplica atributos seguros e não define Domain", () => {
  const cookie = serializeSessionCookie("safe-token_123", { maxAgeSeconds: 3_600 });

  assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=safe-token_123;`));
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.match(cookie, /; Max-Age=3600$/);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test("extrai uma sessão válida e rejeita duplicidade ou caracteres inseguros", () => {
  assert.equal(
    readSessionToken(`theme=dark; ${SESSION_COOKIE_NAME}=abc.DEF_123-xyz; locale=pt-BR`),
    "abc.DEF_123-xyz"
  );
  assert.equal(
    readSessionToken(`${SESSION_COOKIE_NAME}=first; ${SESSION_COOKIE_NAME}=second`),
    null
  );
  assert.equal(readSessionToken(`${SESSION_COOKIE_NAME}=token%0d%0aHeader`), null);
  assert.equal(readSessionToken(undefined), null);
});

test("cookie de logout expira imediatamente com os mesmos atributos de segurança", () => {
  const cookie = serializeExpiredSessionCookie();

  assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=;`));
  assert.match(cookie, /; Max-Age=0$/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test("serialização rejeita token e duração que permitiriam cookie injection", () => {
  assert.throws(
    () => serializeSessionCookie("token; Domain=attacker.example", { maxAgeSeconds: 60 }),
    TypeError
  );
  assert.throws(
    () => serializeSessionCookie("safe-token", { maxAgeSeconds: 0 }),
    TypeError
  );
});
