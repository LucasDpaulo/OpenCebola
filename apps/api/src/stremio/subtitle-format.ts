function assTime(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, centiseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) return null;
  return `${hours!.padStart(2, "0")}:${minutes}:${seconds}.${centiseconds!.padEnd(2, "0")}0`;
}

// Limpeza do campo Text de uma fala ASS/SSA para texto de cue WebVTT. Compartilhada entre o
// arquivo .ass baixado (assToVtt) e as legendas embutidas no MKV (mkv-subtitles.ts), para os dois
// caminhos nunca divergirem na hora de tratar override tags, quebras de linha e escape.
export function assTextToVtt(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .trim();
}

function assToVtt(source: string): string | null {
  if (!source.split("\n").some((line) => line.trim().toLowerCase() === "[events]")) return null;
  let inEvents = false;
  let columns: string[] = [];
  const cues: string[] = [];
  for (const line of source.split("\n")) {
    const section = /^\[([^\]]+)\]$/.exec(line.trim());
    if (section) { inEvents = section[1]!.toLowerCase() === "events"; continue; }
    if (!inEvents) continue;
    const format = /^Format:\s*(.*)$/i.exec(line);
    if (format) { columns = format[1]!.split(",").map((name) => name.trim().toLowerCase()); continue; }
    const dialogue = /^Dialogue:\s*(.*)$/i.exec(line);
    if (!dialogue || columns.length === 0 || columns.at(-1) !== "text") continue;
    const values: string[] = [];
    let remaining = dialogue[1]!;
    for (let index = 0; index < columns.length - 1; index += 1) {
      const comma = remaining.indexOf(",");
      if (comma < 0) break;
      values.push(remaining.slice(0, comma));
      remaining = remaining.slice(comma + 1);
    }
    if (values.length !== columns.length - 1) continue;
    values.push(remaining);
    const start = assTime(values[columns.indexOf("start")] ?? "");
    const end = assTime(values[columns.indexOf("end")] ?? "");
    if (!start || !end || end <= start) continue;
    const text = assTextToVtt(remaining);
    if (text) cues.push(`${start} --> ${end}\n${text}`);
  }
  return `WEBVTT\n\n${cues.join("\n\n")}${cues.length > 0 ? "\n" : ""}`;
}

export function subtitleToVtt(source: string): string {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT(?:\s|$)/.test(normalized)) return normalized;
  const ass = assToVtt(normalized);
  if (ass !== null) return ass;
  return `WEBVTT\n\n${normalized.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    "$1.$2 --> $3.$4"
  )}`;
}
