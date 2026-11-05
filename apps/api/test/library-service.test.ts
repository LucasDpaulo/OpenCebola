import assert from "node:assert/strict";
import test from "node:test";
import {
  upsertLibraryItemRequestSchema,
  type UpsertLibraryItemRequest
} from "@cebola/contracts";
import {
  HouseholdService,
  InMemoryHouseholdRepository,
  ProfileNotFoundError
} from "../src/households/index.js";
import {
  InMemoryLibraryRepository,
  InvalidLibraryItemError,
  LibraryItemNotFoundError,
  LibraryService,
  type LibraryScope
} from "../src/library/index.js";

const movie: UpsertLibraryItemRequest = {
  addonId: "community.cinemeta",
  mediaId: "tt0111161",
  mediaType: "movie",
  name: "The Shawshank Redemption",
  posterUrl: "https://images.example/shawshank-poster.jpg",
  backgroundUrl: "https://images.example/shawshank-background.jpg",
  description: "A story of hope and friendship.",
  releaseInfo: "1994"
};

async function fixture() {
  let householdSequence = 0;
  let librarySequence = 0;
  let timestamp = Date.parse("2026-09-18T12:00:00.000Z");
  const households = new InMemoryHouseholdRepository();
  const householdService = new HouseholdService({
    repository: households,
    generateId: () => `household-record-${++householdSequence}`,
    now: () => new Date(timestamp)
  });
  const firstHousehold = await householdService.createHousehold({
    ownerId: "owner-1",
    name: "Casa 1"
  });
  const secondHousehold = await householdService.createHousehold({
    ownerId: "owner-2",
    name: "Casa 2"
  });
  const firstProfile = await householdService.createProfile({
    householdId: firstHousehold.id,
    name: "Perfil 1"
  });
  const secondProfile = await householdService.createProfile({
    householdId: firstHousehold.id,
    name: "Perfil 2"
  });
  const repository = new InMemoryLibraryRepository();
  const service = new LibraryService({
    repository,
    households,
    generateId: () =>
      `00000000-0000-4000-8000-${String(++librarySequence).padStart(12, "0")}`,
    now: () => new Date(timestamp)
  });

  return {
    firstHousehold,
    secondHousehold,
    firstScope: { householdId: firstHousehold.id, profileId: firstProfile.id } satisfies LibraryScope,
    secondScope: { householdId: firstHousehold.id, profileId: secondProfile.id } satisfies LibraryScope,
    service,
    advanceClock(milliseconds = 1_000) {
      timestamp += milliseconds;
    }
  };
}

test("isola itens que têm a mesma identidade de catálogo entre perfis", async () => {
  const context = await fixture();

  const first = await context.service.upsert(context.firstScope, movie);
  const second = await context.service.upsert(context.secondScope, {
    ...movie,
    name: "Um sonho de liberdade"
  });

  assert.notEqual(first.id, second.id);
  assert.deepEqual((await context.service.list(
    context.firstScope.householdId,
    context.firstScope.profileId
  )).map((item) => item.name), ["The Shawshank Redemption"]);
  assert.deepEqual((await context.service.list(
    context.secondScope.householdId,
    context.secondScope.profileId
  )).map((item) => item.name), ["Um sonho de liberdade"]);
});

test("upsert usa mediaType e mediaId como identidade sem trocar o UUID do registro", async () => {
  const context = await fixture();
  const created = await context.service.upsert(context.firstScope, movie);
  context.advanceClock();

  const updated = await context.service.upsert(context.firstScope, {
    ...movie,
    name: "Um sonho de liberdade"
  });
  const listed = await context.service.list(
    context.firstScope.householdId,
    context.firstScope.profileId
  );

  assert.equal(listed.length, 1);
  assert.equal(updated.id, created.id);
  assert.equal(updated.mediaId, "tt0111161");
  assert.equal(updated.name, "Um sonho de liberdade");
  assert.deepEqual(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt > created.updatedAt);
});

test("o mesmo mediaId em tipos diferentes representa dois itens", async () => {
  const context = await fixture();
  await context.service.upsert(context.firstScope, movie);
  await context.service.upsert(context.firstScope, {
    ...movie,
    mediaType: "series",
    name: "The Shawshank Redemption: The Series"
  });

  const listed = await context.service.list(
    context.firstScope.householdId,
    context.firstScope.profileId
  );
  assert.deepEqual(listed.map((item) => item.mediaType), ["movie", "series"]);
});

test("importação repetida é idempotente e une sem remover itens já existentes", async () => {
  const context = await fixture();
  const existing = await context.service.upsert(context.firstScope, movie);
  const importedItems: readonly UpsertLibraryItemRequest[] = [
    {
      ...movie,
      mediaId: "tt0944947",
      mediaType: "series",
      name: "Game of Thrones"
    },
    {
      ...movie,
      mediaId: "tt0068646",
      name: "The Godfather"
    }
  ];

  context.advanceClock();
  const firstImport = await context.service.import(context.firstScope, importedItems);
  const firstIds = new Map(firstImport.map((item) => [item.mediaId, item.id]));
  context.advanceClock();
  const secondImport = await context.service.import(context.firstScope, importedItems);

  assert.equal(firstImport.length, 3);
  assert.equal(secondImport.length, 3);
  assert.equal(firstIds.get(existing.mediaId), existing.id);
  assert.deepEqual(
    secondImport.map((item) => [item.mediaId, item.id]),
    firstImport.map((item) => [item.mediaId, item.id])
  );
});

test("importação aceita exatamente 200 itens", async () => {
  const context = await fixture();
  const items = Array.from({ length: 200 }, (_, index) => ({
    ...movie,
    mediaId: `catalog-item-${index}`
  }));

  const imported = await context.service.import(context.firstScope, items);

  assert.equal(imported.length, 200);
});

test("importação recusa 201 itens sem persistir uma união parcial", async () => {
  const context = await fixture();
  const items = Array.from({ length: 201 }, (_, index) => ({
    ...movie,
    mediaId: `catalog-item-${index}`
  }));

  await assert.rejects(
    context.service.import(context.firstScope, items),
    InvalidLibraryItemError
  );
  assert.deepEqual(
    await context.service.list(
      context.firstScope.householdId,
      context.firstScope.profileId
    ),
    []
  );
});

test("biblioteca aceita 500 identidades e permite atualização no teto, mas recusa a 501ª", async () => {
  const context = await fixture();
  const items = Array.from({ length: 500 }, (_, index) => ({ ...movie, mediaId: `item-${index}` }));
  for (let offset = 0; offset < items.length; offset += 200) {
    await context.service.import(context.firstScope, items.slice(offset, offset + 200));
  }
  const updated = await context.service.upsert(context.firstScope, {
    ...movie, mediaId: " item-0 ", name: "Atualizado no teto"
  });
  assert.equal(updated.name, "Atualizado no teto");
  await assert.rejects(context.service.upsert(context.firstScope, {
    ...movie, mediaId: "item-0", mediaType: "series"
  }), InvalidLibraryItemError);
  assert.equal((await context.service.list(context.firstScope.householdId, context.firstScope.profileId)).length, 500);
  const otherProfile = await context.service.upsert(context.secondScope, movie);
  assert.equal(otherProfile.name, "The Shawshank Redemption");
});

test("importação calcula a união normalizada antes de qualquer gravação que excederia 500", async () => {
  const context = await fixture();
  const items = Array.from({ length: 499 }, (_, index) => ({ ...movie, mediaId: `item-${index}` }));
  for (let offset = 0; offset < items.length; offset += 200) {
    await context.service.import(context.firstScope, items.slice(offset, offset + 200));
  }
  const before = await context.service.list(context.firstScope.householdId, context.firstScope.profileId);
  await assert.rejects(context.service.import(context.firstScope, [
    { ...movie, mediaId: "item-0", name: "Não deve atualizar" },
    { ...movie, mediaId: "item-499" },
    { ...movie, mediaId: "item-500" }
  ]), InvalidLibraryItemError);
  assert.deepEqual(await context.service.list(context.firstScope.householdId, context.firstScope.profileId), before);
  const accepted = await context.service.import(context.firstScope, [
    { ...movie, mediaId: "item-499" },
    { ...movie, mediaId: " item-499 ", name: "Última versão" }
  ]);
  assert.equal(accepted.length, 500);
  assert.equal(accepted.find((item) => item.mediaId === "item-499")!.name, "Última versão");
  const updated = await context.service.import(context.firstScope, [
    { ...movie, mediaId: " item-0 ", name: "Atualização permitida" }
  ]);
  assert.equal(updated.length, 500);
  assert.equal(updated.find((item) => item.mediaId === "item-0")!.name, "Atualização permitida");
});

test("lista por updatedAt decrescente e desempata por mediaType e mediaId", async () => {
  const context = await fixture();
  await context.service.upsert(context.firstScope, {
    ...movie,
    mediaId: "z-series",
    mediaType: "series"
  });
  await context.service.upsert(context.firstScope, { ...movie, mediaId: "b-movie" });
  await context.service.upsert(context.firstScope, { ...movie, mediaId: "a-movie" });
  context.advanceClock();
  await context.service.upsert(context.firstScope, {
    ...movie,
    mediaId: "newest",
    mediaType: "series"
  });

  const listed = await context.service.list(
    context.firstScope.householdId,
    context.firstScope.profileId
  );
  assert.deepEqual(listed.map((item) => `${item.mediaType}:${item.mediaId}`), [
    "series:newest",
    "movie:a-movie",
    "movie:b-movie",
    "series:z-series"
  ]);
});

test("remove somente o item solicitado e informa quando ele não existe", async () => {
  const context = await fixture();
  await context.service.upsert(context.firstScope, movie);
  await context.service.upsert(context.firstScope, {
    ...movie,
    mediaId: "tt0944947",
    mediaType: "series"
  });

  await context.service.remove(context.firstScope, movie.mediaType, movie.mediaId);
  assert.deepEqual((await context.service.list(
    context.firstScope.householdId,
    context.firstScope.profileId
  )).map((item) => item.mediaId), ["tt0944947"]);
  await assert.rejects(
    context.service.remove(context.firstScope, movie.mediaType, movie.mediaId),
    LibraryItemNotFoundError
  );
});

test("todas as operações recusam perfil que não pertence à casa", async () => {
  const context = await fixture();
  const foreignScope = {
    householdId: context.secondHousehold.id,
    profileId: context.firstScope.profileId
  };

  await assert.rejects(
    context.service.list(foreignScope.householdId, foreignScope.profileId),
    ProfileNotFoundError
  );
  await assert.rejects(context.service.upsert(foreignScope, movie), ProfileNotFoundError);
  await assert.rejects(
    context.service.remove(foreignScope, movie.mediaType, movie.mediaId),
    ProfileNotFoundError
  );
  await assert.rejects(context.service.import(foreignScope, [movie]), ProfileNotFoundError);
});

test("normaliza IDs e nomes e aplica os limites dos contratos públicos", async () => {
  const context = await fixture();
  const normalized = await context.service.upsert(context.firstScope, {
    ...movie,
    addonId: "  community.cinemeta  ",
    mediaId: "  tt0111161  ",
    name: "  The Shawshank Redemption  "
  });

  assert.equal(normalized.addonId, "community.cinemeta");
  assert.equal(normalized.mediaId, "tt0111161");
  assert.equal(normalized.name, "The Shawshank Redemption");
  await assert.rejects(
    context.service.upsert(context.firstScope, { ...movie, addonId: "x".repeat(201) }),
    InvalidLibraryItemError
  );
  await assert.rejects(
    context.service.upsert(context.firstScope, { ...movie, mediaId: "bad\u0000id" }),
    InvalidLibraryItemError
  );
  await assert.rejects(
    context.service.upsert(context.firstScope, { ...movie, description: "x".repeat(5_001) }),
    InvalidLibraryItemError
  );
  await assert.rejects(
    context.service.upsert(context.firstScope, { ...movie, releaseInfo: "x".repeat(101) }),
    InvalidLibraryItemError
  );
});

test("aceita esquema HTTPS em caixa alta sem alterar a URL", async () => {
  const context = await fixture();
  const posterUrl = "HTTPS://images.example/poster.jpg";
  const backgroundUrl = "HTTPS://images.example/background.jpg";
  const input = { ...movie, posterUrl, backgroundUrl };

  assert.deepEqual(upsertLibraryItemRequestSchema.parse(input), input);
  const item = await context.service.upsert(context.firstScope, input);

  assert.equal(item.posterUrl, posterUrl);
  assert.equal(item.backgroundUrl, backgroundUrl);
});
