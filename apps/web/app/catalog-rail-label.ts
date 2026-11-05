type CatalogRailIdentity = {
  readonly catalogId: string;
  readonly name: string;
  readonly type: "movie" | "series";
};

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

/**
 * Add-ons entregam nomes de catálogo como "Popular" ou "Top". Eles não explicam o recorte
 * para quem está escolhendo algo para assistir, então a vitrine dá contexto sem fingir saber
 * gênero, estúdio ou plataforma que a fonte não informou.
 */
export function catalogRailLabel(rail: CatalogRailIdentity): string {
  const kind = rail.type === "movie" ? "Filmes" : "Séries";
  const source = normalized(`${rail.catalogId} ${rail.name}`);

  // Alguns add-ons expõem nomes de implementação em inglês. Aqui há significado suficiente
  // para traduzi-los sem criar uma promessa editorial que a fonte não fornece.
  if (/\bcalendar videos?\b/.test(source)) {
    return rail.type === "movie" ? "Próximos filmes para acompanhar" : "Próximos episódios para acompanhar";
  }
  if (/\blast videos?\b/.test(source)) {
    return rail.type === "movie" ? "Filmes adicionados por último" : "Séries adicionadas por último";
  }
  if (/\bfeatured\b/.test(source)) return `${kind} em destaque`;
  if (/\bnetflix\b/.test(source)) return `${kind} disponíveis na Netflix`;
  if (/\b(popular|populares)\b/.test(source)) return `${kind} que todo mundo está vendo`;
  if (/\b(trending|em alta)\b/.test(source)) return `${kind} em alta esta semana`;
  if (/\b(recent|recentes|recently added|added)\b/.test(source)) {
    return rail.type === "movie" ? "Filmes recém-chegados" : "Séries recém-chegadas";
  }
  if (/\b(new|novidade|novidades|lancamento|lancamentos)\b/.test(source)) {
    return rail.type === "movie" ? "Novos filmes para descobrir" : "Novas séries para descobrir";
  }
  if (/\b(top|top10|top 10)\b/.test(source)) return `Top ${kind.toLocaleLowerCase("pt-BR")} do momento`;

  return rail.name;
}
