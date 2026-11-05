/** Pendências locais por perfil. Nunca guarda credenciais nem URLs temporárias de streams. */
const PREFIX = "cebola:progress-pending:v1:";

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function read(profileId: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(PREFIX + profileId) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

function key(body: string): string {
  const item = JSON.parse(body) as { mediaId: string; videoId: string; completed?: boolean; positionSeconds: number; durationSeconds: number };
  // Preserva a conclusão mesmo se a pessoa começar a rever antes de a rede voltar.
  const finished = item.completed === true || item.positionSeconds / item.durationSeconds >= 0.9;
  return JSON.stringify([item.mediaId, item.videoId, finished]);
}

export function rememberProgress(profileId: string, body: string): void {
  try {
    const items = read(profileId);
    const id = key(body);
    const previous = items[id];
    if (previous && Date.parse(JSON.parse(previous).observedAt) > Date.parse(JSON.parse(body).observedAt)) return;
    storage()?.setItem(PREFIX + profileId, JSON.stringify({ ...items, [id]: body }));
  }
  catch { /* Armazenamento indisponível não impede a tentativa pela rede. */ }
}

export function forgetProgress(profileId: string, body: string): void {
  try {
    const items = read(profileId);
    const id = key(body);
    // Uma resposta atrasada não remove uma gravação nova ainda em voo.
    if (items[id] !== body) return;
    delete items[id];
    if (Object.keys(items).length === 0) storage()?.removeItem(PREFIX + profileId);
    else storage()?.setItem(PREFIX + profileId, JSON.stringify(items));
  } catch { /* Storage pode ter sido revogado. */ }
}

export function pendingProgress(profileId: string): string[] {
  return Object.values(read(profileId)).filter((body) => {
    try {
      const item = JSON.parse(body) as { expectedProfileId?: string; observedAt?: string };
      return item.expectedProfileId === profileId && Number.isFinite(Date.parse(item.observedAt ?? ""));
    } catch { return false; }
  }).sort((a, b) => Date.parse(JSON.parse(a).observedAt) - Date.parse(JSON.parse(b).observedAt));
}
