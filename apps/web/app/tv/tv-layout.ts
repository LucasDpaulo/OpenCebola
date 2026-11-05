// Lógica pura por trás do layout de TV: nenhuma dependência de React ou de DOM aqui, só para o
// teste poder importar e cobrir as combinações sem precisar montar um componente.
//
// Regra (plano `docs/superpowers/plans/2026-09-27-interface-tv-projetor.md`, Task 0): o layout
// de TV liga por `isTvRuntime()`. Para testar no PC sem o projetor, `?tv=1`/`?tv=0` força o
// estado e grava a preferência (localStorage), que passa a valer nas próximas visitas até a
// query mandar o contrário.

export const TV_LAYOUT_STORAGE_KEY = "cebola:tv-layout";

export type TvLayoutStore = "on" | "off" | null;

export interface ResolveTvLayoutInput {
  isTv: boolean;
  queryValue: string | null;
  stored: string | null;
}

export interface ResolveTvLayoutResult {
  enabled: boolean;
  store: TvLayoutStore;
}

export function resolveTvLayout({ isTv, queryValue, stored }: ResolveTvLayoutInput): ResolveTvLayoutResult {
  if (queryValue === "1") return { enabled: true, store: "on" };
  if (queryValue === "0") return { enabled: false, store: "off" };
  if (stored === "on") return { enabled: true, store: null };
  if (stored === "off") return { enabled: false, store: null };
  return { enabled: isTv, store: null };
}

/**
 * Build de prévia de TV para o PC (AppImage de teste do Lucas): ali não dá pra digitar `?tv=1` na
 * barra de endereço, então o layout de TV liga sozinho quando o build foi feito com essa variável.
 * `NEXT_PUBLIC_*` é resolvida em tempo de build pelo Next; em produção ela nunca é definida, então
 * isto nunca liga sozinho fora desse build de teste.
 */
export function isTvPreviewBuild(): boolean {
  return process.env.NEXT_PUBLIC_CEBOLA_TV_PREVIEW === "1";
}

/*
 * A Samsung pinta e decodifica imagem na CPU, e o custo vai pelo tamanho em que a imagem CHEGA,
 * não pelo tamanho na tela: pôster 500×750 e backdrop 1920×1080 para um card de ~200×300 (ou
 * 512×288 focado) faziam cada seta para baixo travar ~0,3 s só decodificando (medido na TV). Na
 * TV os cards pedem o tamanho mais próximo do que mostram; URLs de outras origens passam iguais.
 */
const TMDB_IMAGE = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(\w+)\//;
const METAHUB_IMAGE = /^(https:\/\/images\.metahub\.space\/(?:poster|background)\/)(medium|large)\//;

function resize(url: string, tmdbSize: string, larger: readonly string[]): string {
  const tmdb = TMDB_IMAGE.exec(url);
  if (tmdb) return larger.includes(tmdb[2]!) ? url.replace(TMDB_IMAGE, `$1${tmdbSize}/`) : url;
  return url.replace(METAHUB_IMAGE, "$1small/");
}

/** Arte horizontal do card focado (~512×288): TMDB `w780`, metahub `small` (480×270). */
export function tvCardBackdropUrl(url: string): string {
  return resize(url, "w780", ["w1280", "original"]);
}

/**
 * Pôster do card (~198×298): TMDB `w185`, metahub `small` (300×450). A Samsung guarda só 20 MB de
 * imagem decodificada (`--discardable-memory-limit=20`): com `w342` cabiam ~28 pôsteres e as
 * fileiras já vistas eram decodificadas de novo a cada volta. `w185` cabe ~100 e decodifica em
 * ~1/4 do tempo (medido na TV); a ampliação de 7% não aparece no sofá.
 */
export function tvPosterUrl(url: string): string {
  return resize(url, "w185", ["w342", "w500", "w780", "w1280", "original"]);
}

/** Logo do serviço de streaming (~20×20 no card): TMDB `w92`. */
export function tvLogoUrl(url: string): string {
  return resize(url, "w92", ["w154", "w185", "w300", "w500", "original"]);
}
