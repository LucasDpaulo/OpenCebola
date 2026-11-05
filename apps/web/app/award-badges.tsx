type AwardKind = "winner" | "nominee" | "festival";

export type AwardMark = { readonly kind: AwardKind; readonly count: number };

// Curadoria inicial por TMDB ID. Os números são totais de Oscar; festival marca uma conquista
// editorial adicional (Palma de Ouro). Manter IDs evita qualquer erro causado por tradução.
const AWARDS = new Map<number, readonly AwardMark[]>([
  [238, [{ kind: "winner", count: 3 }, { kind: "nominee", count: 11 }]], // O Poderoso Chefão
  [240, [{ kind: "winner", count: 6 }, { kind: "nominee", count: 11 }]], // O Poderoso Chefão II
  [278, [{ kind: "nominee", count: 7 }]], // Um Sonho de Liberdade
  [424, [{ kind: "winner", count: 7 }, { kind: "nominee", count: 12 }]], // A Lista de Schindler
  [122, [{ kind: "winner", count: 11 }, { kind: "nominee", count: 11 }]], // O Retorno do Rei
  [438631, [{ kind: "winner", count: 6 }, { kind: "nominee", count: 10 }]], // Duna
  [496243, [{ kind: "winner", count: 4 }, { kind: "nominee", count: 6 }, { kind: "festival", count: 1 }]], // Parasita
  [545611, [{ kind: "winner", count: 7 }, { kind: "nominee", count: 11 }]], // Tudo em Todo Lugar
  [581734, [{ kind: "winner", count: 3 }, { kind: "nominee", count: 6 }]], // Nomadland
  [872585, [{ kind: "winner", count: 7 }, { kind: "nominee", count: 13 }]] // Oppenheimer
]);

export function AwardBadges({ tmdbId }: { readonly tmdbId: number }) {
  const marks = AWARDS.get(tmdbId);
  if (!marks) return null;
  const premiado = marks.some((mark) => mark.kind === "winner" || mark.kind === "festival");
  return (
    <span
      className={`award-ribbon ${premiado ? "award-ribbon-winner" : "award-ribbon-nominee"}`}
      aria-label={premiado ? "Título premiado" : "Título indicado"}
      title={premiado ? "Premiado" : "Indicado"}
    />
  );
}
