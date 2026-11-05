// Lógica pura da navegação vertical por zonas da TV.
//
// Por quê: a geometria do `@bbc/tv-lrud-spatial` (distância entre bordas) não é confiável na
// home — os cards crescem quando ganham foco e as fileiras têm alturas bem diferentes umas das
// outras, então ↑/↓ por "candidato mais próximo" acaba pulando pro lugar errado (do banner não
// chegava no menu; depois de "Continuar" o ↓ não descia; no fim de uma fileira, com o card
// focado à direita, ↑ não subia). A correção troca ↑/↓ por ZONAS: cada bloco vertical da home
// (menu, banner, cada fileira) marca `data-tv-zone` na ordem em que aparece no documento, e
// ↑/↓ andam de zona em zona nessa ordem — sem olhar geometria nenhuma.
//
// Esta função só decide o ÍNDICE da zona seguinte/anterior; ler o DOM (quais zonas existem, o
// que cada uma tem de focável, focar e rolar) é trabalho do `tv-navigation.tsx`, que não dá pra
// testar sem montar um DOM inteiro — o que importa acertar é só esta conta.

export type TvZoneDirection = "up" | "down";

/**
 * Acha, na direção pedida, o índice da zona mais próxima que tem algum focável — pulando zonas
 * vazias (ex.: uma fileira que ainda não carregou nenhum item). `hasFocusable[i]` diz se a zona
 * `i` (na ordem do DOM) tem algo focável agora. `currentIndex` pode ser `-1` (foco fora de
 * qualquer zona: sobe a partir do fim, desce a partir do início) ou `hasFocusable.length`
 * (mesma ideia, do outro lado). Devolve `null` quando não existe zona válida nessa direção —
 * sinal para o chamador não fazer nada (não é pra "sobrar" numa zona por geometria).
 */
export function findAdjacentTvZoneIndex(
  hasFocusable: readonly boolean[],
  currentIndex: number,
  direction: TvZoneDirection
): number | null {
  const step = direction === "up" ? -1 : 1;
  for (let index = currentIndex + step; index >= 0 && index < hasFocusable.length; index += step) {
    if (hasFocusable[index]) return index;
  }
  return null;
}
