import assert from "node:assert/strict";
import test from "node:test";
import type { LibraryItem } from "@cebola/contracts";
import { isHomeBootstrap } from "../app/home-experience.js";

function libraryItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    addonId: "com.stremio.addon",
    mediaId: "tt0111161",
    mediaType: "movie",
    name: "Um Sonho de Liberdade",
    posterUrl: "https://images.example.com/poster.jpg",
    backgroundUrl: null,
    description: null,
    releaseInfo: "1994",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function bootstrap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activeProfile: {
      id: "profile-1",
      name: "Perfil",
      avatarUrl: null,
      hasPin: false
    },
    progress: { items: [] },
    library: { items: [libraryItem()] },
    stremio: { linked: false },
    ...overrides
  };
}

test("isHomeBootstrap aceita o bootstrap com perfil ativo, progresso e biblioteca válidos", () => {
  assert.equal(isHomeBootstrap(bootstrap()), true);
});

test("isHomeBootstrap aceita biblioteca vazia quando não há perfil ativo", () => {
  assert.equal(isHomeBootstrap(bootstrap({ activeProfile: null, library: { items: [] } })), true);
});

test("isHomeBootstrap rejeita quando o campo library está ausente", () => {
  const body = bootstrap();
  delete (body as { library?: unknown }).library;
  assert.equal(isHomeBootstrap(body), false);
});

test("isHomeBootstrap rejeita item de biblioteca com posterUrl não-https", () => {
  const body = bootstrap({ library: { items: [libraryItem({ posterUrl: "http://images.example.com/poster.jpg" })] } });
  assert.equal(isHomeBootstrap(body), false);
});

test("isHomeBootstrap rejeita item de biblioteca sem os campos internos válidos (mediaId ausente)", () => {
  const invalid = { ...libraryItem() } as Record<string, unknown>;
  delete invalid.mediaId;
  const body = bootstrap({ library: { items: [invalid] } });
  assert.equal(isHomeBootstrap(body), false);
});

test("isHomeBootstrap rejeita quando activeProfile é inválido", () => {
  const body = bootstrap({ activeProfile: { id: "profile-1" } });
  assert.equal(isHomeBootstrap(body), false);
});
