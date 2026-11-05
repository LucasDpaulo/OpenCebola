// Painel "Registro de erros" das configurações do Stremio (ver stremio-settings.tsx no web):
// o dono às vezes só descobre que a reprodução falhou olhando a TV/projetor, onde não dá para
// copiar texto nenhum. Este log deixa qualquer aparelho da casa registrar o que viu, e o dono
// lê pelo PC. É só memória do processo — sem tabela, sem migração — porque o valor todo está em
// "o que aconteceu agora", não em histórico permanente; reiniciar a API já limpa o quadro.

/** O que o cliente manda, ou o que a própria rota captura de um erro conhecido. */
export interface DiagnosticsEntryInput {
  readonly origin: "servidor" | "aparelho";
  readonly code: string;
  readonly message: string;
  readonly route?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly context?: Record<string, string>;
  readonly device?: string;
}

export interface DiagnosticsEntry extends DiagnosticsEntryInput {
  readonly at: string;
}

const MAX_ENTRIES_PER_HOUSEHOLD = 150;
const MAX_HOUSEHOLDS = 50;
const MAX_CONTEXT_KEYS = 10;

const LENGTHS = {
  code: 64,
  message: 300,
  detail: 300,
  route: 200,
  device: 120,
  contextKey: 40,
  contextValue: 200
} as const;

// Controle (inclusive DEL) fora do texto: nada aqui deveria ter quebra de linha ou caractere
// invisível, e um deles escondido no meio de "message" já atrapalhou leitura de log antes.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// Qualquer link http(s) — de fonte de vídeo, de legenda, do próprio Real-Debrid — carrega token
// ou link assinado na query/no path. Trocar por só o host preserva o que ajuda a investigar
// (qual provedor respondeu) sem o que nunca pode sair da API.
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

function redactUrls(value: string): string {
  return value.replace(URL_PATTERN, (match) => {
    try {
      return new URL(match).host;
    } catch {
      return "<url>";
    }
  });
}

// Ordem importa: redige a URL inteira (curta) primeiro, só depois trunca — do contrário um link
// longo podia ser cortado no meio, antes da redação, e vazar o começo com o token.
function sanitizeText(value: string, maxLength: number): string {
  const semControle = value.replace(CONTROL_CHARS, "");
  const semLink = redactUrls(semControle);
  return semLink.slice(0, maxLength).trim();
}

function sanitizeContext(
  context: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!context) return undefined;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(context).slice(0, MAX_CONTEXT_KEYS)) {
    if (typeof value !== "string") continue;
    const safeKey = sanitizeText(key, LENGTHS.contextKey);
    if (!safeKey) continue;
    sanitized[safeKey] = sanitizeText(value, LENGTHS.contextValue);
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeEntry(entry: DiagnosticsEntryInput, at: string): DiagnosticsEntry {
  const context = sanitizeContext(entry.context);
  const route = entry.route !== undefined ? sanitizeText(entry.route, LENGTHS.route) : undefined;
  const detail = entry.detail !== undefined ? sanitizeText(entry.detail, LENGTHS.detail) : undefined;
  const device = entry.device !== undefined ? sanitizeText(entry.device, LENGTHS.device) : undefined;
  return {
    at,
    origin: entry.origin,
    code: sanitizeText(entry.code, LENGTHS.code) || "UNKNOWN",
    message: sanitizeText(entry.message, LENGTHS.message),
    ...(route ? { route } : {}),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(detail ? { detail } : {}),
    ...(context ? { context } : {}),
    ...(device ? { device } : {})
  };
}

/**
 * Anel por casa, não um log global: uma casa barulhenta (ex.: TV reconectando addon) não pode
 * empurrar para fora o único erro que outra casa teve no dia. O teto de 50 casas existe só para
 * a memória do processo não crescer sem limite num servidor com muitas contas — quem escreveu
 * por último nunca é a evictada, por isso a ordem de reinserção no Map abaixo.
 */
export class DiagnosticsLog {
  readonly #entries = new Map<string, DiagnosticsEntry[]>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  record(householdId: string, entry: DiagnosticsEntryInput): void {
    const sanitized = sanitizeEntry(entry, this.#now().toISOString());
    // Deletar antes de reinserir move a chave para o fim da ordem de iteração do Map — é essa
    // ordem que a eviction abaixo lê como "menos recentemente escrita primeiro".
    const list = this.#entries.get(householdId) ?? [];
    this.#entries.delete(householdId);
    list.push(sanitized);
    if (list.length > MAX_ENTRIES_PER_HOUSEHOLD) list.shift();
    this.#entries.set(householdId, list);
    while (this.#entries.size > MAX_HOUSEHOLDS) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  list(householdId: string): readonly DiagnosticsEntry[] {
    const list = this.#entries.get(householdId);
    return list ? [...list].reverse() : [];
  }

  clear(householdId: string): void {
    this.#entries.delete(householdId);
  }
}
