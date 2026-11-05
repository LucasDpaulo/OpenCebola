// O `label` de uma legenda chega como "Idioma[ N] · release · addon" (title-browser-player.tsx) ou só
// "Idioma" nos players nativos. Na TV o idioma vai em destaque e o resto, discreto, embaixo.

import { normalizedTrackLanguage } from "./subtitle-selection";

export function nativeTrackLabel(label: string | null | undefined, language: string | null | undefined, index: number): string {
  const name = label?.trim() ?? "";
  const code = normalizedTrackLanguage({ label: name, language: language ?? null });
  let languageName = "Idioma não informado";
  if (code) {
    try { languageName = new Intl.DisplayNames(["pt-BR"], { type: "language" }).of(code) ?? code; }
    catch { languageName = code; }
    languageName = languageName.charAt(0).toUpperCase() + languageName.slice(1);
  }
  if (!name || /^(?:track|faixa|subtitle|legenda)\s*\d+$/i.test(name) || name.toLowerCase() === language?.toLowerCase()) {
    return `${languageName} · Faixa ${index}`;
  }
  if (name.toLowerCase() === languageName.toLowerCase()) return name;
  return code ? `${languageName} · ${name}` : `${name} · Idioma não informado`;
}

export function splitSubtitleLabel(label: string): { language: string; details: string } {
  const index = label.indexOf(" · ");
  const rawLanguage = index === -1 ? label : label.slice(0, index);
  const details = index === -1 ? "" : label.slice(index + 3).trim();
  // O sufixo numérico (" 2", " 3") só desambigua várias legendas do mesmo idioma na lista.
  const language = rawLanguage.replace(/\s+\d+$/, "").trim();
  return { language, details };
}
