import assert from "node:assert/strict";
import test from "node:test";
import { catalogRailLabel } from "../app/catalog-rail-label.js";

test("troca rótulos vagos de add-ons por uma explicação de conteúdo", () => {
  assert.equal(
    catalogRailLabel({ catalogId: "popular", name: "Popular", type: "movie" }),
    "Filmes que todo mundo está vendo"
  );
  assert.equal(
    catalogRailLabel({ catalogId: "recently-added", name: "Recentes", type: "series" }),
    "Séries recém-chegadas"
  );
  assert.equal(
    catalogRailLabel({ catalogId: "new-releases", name: "Novidades", type: "movie" }),
    "Novos filmes para descobrir"
  );
  assert.equal(
    catalogRailLabel({ catalogId: "top", name: "Top 10", type: "movie" }),
    "Top filmes do momento"
  );
});

test("preserva uma curadoria específica que o add-on já explicou", () => {
  assert.equal(
    catalogRailLabel({ catalogId: "documentarios-br", name: "Documentários brasileiros", type: "movie" }),
    "Documentários brasileiros"
  );
});

test("traduz nomes técnicos recorrentes de catálogo para uma intenção de conteúdo", () => {
  assert.equal(catalogRailLabel({ catalogId: "featured", name: "Featured", type: "movie" }), "Filmes em destaque");
  assert.equal(catalogRailLabel({ catalogId: "last-videos", name: "Last Videos", type: "series" }), "Séries adicionadas por último");
  assert.equal(catalogRailLabel({ catalogId: "calendar-videos", name: "Calendar Videos", type: "series" }), "Próximos episódios para acompanhar");
  assert.equal(catalogRailLabel({ catalogId: "netflix", name: "Netflix", type: "movie" }), "Filmes disponíveis na Netflix");
});
