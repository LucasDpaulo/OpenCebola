// Etiquetas de uma fonte (release de torrent) para a aba Fontes da TV: o nome do release já diz
// origem, vídeo e áudio, e é o que ajuda a escolher sem abrir cada opção.
//
// Sem lookbehind (`(?<!...)`): a casca da TV Samsung pode ter um Chromium velho em que ele é erro
// de sintaxe e derrubaria o bundle inteiro. A "borda" de token é feita com grupo não capturante.

const START = "(?:^|[^a-z0-9])";

function token(pattern: string, after = "(?![a-z0-9])"): RegExp {
  return new RegExp(`${START}(?:${pattern})${after}`, "i");
}

const ORIGIN: readonly (readonly [string, RegExp])[] = [
  ["REMUX", token("remux")],
  ["BluRay", token("blu-?ray|bdrip|brrip")],
  ["WEB-DL", token("web-?dl")],
  ["WEBRip", token("web-?rip")],
  ["HDTV", token("hdtv")],
  ["DVDRip", token("dvd-?rip")]
];

// "DV" só como token isolado e "DD" só isolado ou seguido de número: "DVDRip" e "ADD" não contam.
const VIDEO: readonly (readonly [string, RegExp])[] = [
  ["Dolby Vision", token("dv|dovi|dolby[ ._-]?vision")],
  ["HDR10+", token("hdr10\\+|hdr10plus")],
  ["HDR10", token("hdr10", "(?![a-z0-9+])")],
  ["HDR", token("hdr", "(?![a-z0-9])")],
  ["HEVC", token("hevc|x265|h[ .]?265")],
  ["AV1", token("av1")],
  ["10-bit", token("10-?bit|hi10p?")]
];

const AUDIO: readonly (readonly [string, RegExp])[] = [
  ["Dolby Atmos", token("atmos", "(?![a-z])")],
  ["Dolby TrueHD", token("true-?hd", "(?![a-z])")],
  ["Dolby Digital Plus", token("ddp|dd\\+|e-?ac-?3", "(?![a-z])")],
  ["Dolby Digital", token("dd|ac-?3", "(?![a-z+])")],
  ["DTS-HD MA", token("dts-?hd[ .-]?ma")],
  ["DTS-X", token("dts-?x")],
  ["DTS", token("dts", "(?![a-z])")],
  ["AAC", token("aac", "(?![a-z])")]
];

const CHANNELS = /(?:^|[^0-9])(7\.1|5\.1|2\.0)(?![0-9])/;

export function sourceReleaseTags(label: string): string[] {
  const text = label.replace(/[_\s]+/g, ".");
  const tags: string[] = [];
  const add = (tag: string) => { if (!tags.includes(tag)) tags.push(tag); };

  for (const [tag, re] of ORIGIN) if (re.test(text)) add(tag);

  const video = VIDEO.filter(([, re]) => re.test(text)).map(([tag]) => tag);
  // HDR10+/HDR10 já dizem tudo; "HDR" solto só entra quando não há variante nomeada.
  for (const tag of video) {
    if (tag === "HDR" && (video.includes("HDR10") || video.includes("HDR10+"))) continue;
    add(tag);
  }

  const audio = AUDIO.filter(([, re]) => re.test(text)).map(([tag]) => tag);
  for (const tag of audio) {
    // "DD" casa também dentro de DD+/DDP em alguns nomes; a variante Plus vence.
    if (tag === "Dolby Digital" && audio.includes("Dolby Digital Plus")) continue;
    if (tag === "DTS" && (audio.includes("DTS-HD MA") || audio.includes("DTS-X"))) continue;
    add(tag);
  }
  const channels = CHANNELS.exec(text);
  if (channels) add(channels[1]);
  return tags;
}
