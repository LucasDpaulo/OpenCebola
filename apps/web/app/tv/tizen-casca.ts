/**
 * Conversa com a casca da TV Samsung (apps/tizen/www). Na Samsung o site roda dentro de um
 * <iframe> da casca local, e só a casca enxerga o AVPlay (o player nativo da TV): o site pede
 * as operações por `postMessage` e a casca as executa (apps/tizen/www/ponte.js define o
 * protocolo, versão 1 — este arquivo é o lado do site).
 *
 * Nada disto liga fora da casca: `dentroDaCasca()` exige iframe E User-Agent Tizen E a marca
 * `casca=1`. PC, celular, Android TV e o navegador comum nunca chegam a mandar uma mensagem.
 */

export type EstadoCasca = "pendente" | "com-avplay" | "sem-avplay";

/** Evento espontâneo da casca (posição, fim, erro, legenda, buffer). */
export interface EventoCasca {
  readonly tipo: string;
  readonly valor: unknown;
}

const CHAVE_SESSAO = "cebola.casca";
// O WGT instalado pode ser de uma versão sem ponte: ele embute o site mas nunca responde ao
// `ola`. Sem este limite, o player esperaria a casca para sempre em vez de cair no navegador.
const ESPERA_OLA_MS = 3_000;
const ESPERA_PADRAO_MS = 5_000;

/**
 * Verdadeiro só quando o site está embutido na casca da Samsung. O parâmetro `casca=1` (posto
 * pela casca na URL do iframe) vale uma vez e fica no sessionStorage: a navegação do Next troca
 * a URL e o parâmetro some, mas a página continua dentro da casca.
 */
export function dentroDaCasca(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  // Comparar referências de janelas de origens diferentes é permitido (não lê nada do pai).
  if (window.parent === window) return false;
  if (!/\bTizen\b/i.test(navigator.userAgent)) return false;
  let marcadoNaUrl = false;
  try {
    marcadoNaUrl = new URLSearchParams(window.location.search).get("casca") === "1";
  } catch {
    // URL ilegível: segue só com a marca da sessão.
  }
  try {
    if (marcadoNaUrl) {
      window.sessionStorage.setItem(CHAVE_SESSAO, "1");
      return true;
    }
    return window.sessionStorage.getItem(CHAVE_SESSAO) === "1";
  } catch {
    // Armazenamento bloqueado: a URL sozinha ainda vale para a página de entrada.
    return marcadoNaUrl;
  }
}

type Pendente = {
  readonly resolve: (valor: unknown) => void;
  readonly reject: (erro: Error) => void;
  readonly temporizador: number;
};

let estado: EstadoCasca = "pendente";
let iniciada = false;
let motorLocal = false;
export function motorLocalCasca(): boolean { return dentroDaCasca() && motorLocal; }
let limiteDoOla: number | null = null;
let proximoId = 1;
const pendentes = new Map<number, Pendente>();
const assinantes = new Set<(evento: EventoCasca) => void>();
const esperandoOla = new Set<(resultado: EstadoCasca) => void>();

export function estadoCasca(): EstadoCasca {
  return estado;
}

function mudarEstado(novo: EstadoCasca): void {
  if (estado === novo) return;
  estado = novo;
  if (novo === "pendente") return;
  if (limiteDoOla !== null) window.clearTimeout(limiteDoOla);
  limiteDoOla = null;
  for (const aviso of [...esperandoOla]) aviso(novo);
  esperandoOla.clear();
}

function enviarAoPai(mensagem: Record<string, unknown>): void {
  // "*" porque a casca é file:// (origem opaca, não dá para nomear). Quem garante que só a página
  // local do app embute o site é o `frame-ancestors 'self' file:` do servidor.
  window.parent.postMessage(mensagem, "*");
}

function aoReceber(evento: MessageEvent): void {
  // Só o pai direto: qualquer outra janela (extensão, outro iframe) é ignorada.
  if (evento.source !== window.parent) return;
  const dados: unknown = evento.data;
  if (typeof dados !== "object" || dados === null) return;
  const mensagem = dados as Record<string, unknown>;
  if (typeof mensagem.cebola !== "string") return;

  if (mensagem.cebola === "casca") {
    // Aceita até depois do limite de espera: o estado se corrige, e o player só decide por ele
    // na próxima abertura.
    motorLocal = mensagem.streaming === true;
    mudarEstado(mensagem.avplay === true ? "com-avplay" : "sem-avplay");
    return;
  }
  if (mensagem.cebola === "avplay:resposta") {
    const id = mensagem.id;
    if (typeof id !== "number") return;
    const espera = pendentes.get(id);
    if (!espera) return;
    pendentes.delete(id);
    window.clearTimeout(espera.temporizador);
    if (mensagem.ok === true) espera.resolve(mensagem.valor);
    else espera.reject(new Error(typeof mensagem.erro === "string" && mensagem.erro ? mensagem.erro : "A casca recusou a operação."));
    return;
  }
  if (mensagem.cebola === "avplay:evento" && typeof mensagem.tipo === "string") {
    const aviso: EventoCasca = { tipo: mensagem.tipo, valor: mensagem.valor };
    for (const assinante of [...assinantes]) assinante(aviso);
  }
}

/**
 * Cumprimenta a casca e passa a ouvi-la. Idempotente e sem efeito fora da casca. Chamada cedo,
 * em toda página, para a resposta já estar pronta quando um vídeo for aberto.
 */
export function iniciarCasca(): void {
  if (iniciada || !dentroDaCasca()) return;
  iniciada = true;
  document.documentElement.classList.add("casca-tizen");
  window.addEventListener("message", aoReceber);
  limiteDoOla = window.setTimeout(() => { if (estado === "pendente") mudarEstado("sem-avplay"); }, ESPERA_OLA_MS);
  try {
    enviarAoPai({ cebola: "ola" });
  } catch {
    mudarEstado("sem-avplay");
  }
}

/** Resolve quando a casca já respondeu ao `ola` (ou o limite de espera passou). */
export function aguardarCasca(): Promise<EstadoCasca> {
  iniciarCasca();
  if (estado !== "pendente") return Promise.resolve(estado);
  // Fora da casca nunca haveria resposta: não deixa a promessa pendente.
  if (!iniciada) return Promise.resolve("sem-avplay");
  return new Promise((resolve) => { esperandoOla.add(resolve); });
}

/**
 * Pede uma operação do AVPlay à casca. Rejeita com a mensagem curta da casca (sem URL) quando ela
 * recusa, e por tempo quando ela não responde — o AVPlay às vezes aceita o comando e nunca volta.
 */
export function enviarCasca(op: string, args: Record<string, unknown> = {}, timeoutMs = ESPERA_PADRAO_MS): Promise<unknown> {
  iniciarCasca();
  if (!iniciada) return Promise.reject(new Error("Fora da casca da TV."));
  const id = proximoId++;
  return new Promise<unknown>((resolve, reject) => {
    const temporizador = window.setTimeout(() => {
      pendentes.delete(id);
      reject(new Error(`A casca não respondeu (${op}).`));
    }, timeoutMs);
    pendentes.set(id, { resolve, reject, temporizador });
    try {
      enviarAoPai({ cebola: "avplay", id, op, args });
    } catch (erro) {
      pendentes.delete(id);
      window.clearTimeout(temporizador);
      reject(erro instanceof Error ? erro : new Error("Não foi possível falar com a casca."));
    }
  });
}

/** Ouve os eventos do AVPlay (posição, fim, erro, legenda, buffer). Devolve como desinscrever. */
export function aoEventoCasca(ouvinte: (evento: EventoCasca) => void): () => void {
  assinantes.add(ouvinte);
  return () => { assinantes.delete(ouvinte); };
}

/** Pede à casca para fechar o app (Voltar na tela inicial). */
export function sairDaCasca(): void {
  try {
    enviarAoPai({ cebola: "sair" });
  } catch {
    // sem pai alcançável: nada a fechar.
  }
}

/** Só para testes: volta o módulo ao estado de página recém-aberta. */
export function reiniciarCascaParaTeste(): void {
  if (typeof window !== "undefined") window.removeEventListener?.("message", aoReceber);
  for (const espera of pendentes.values()) window.clearTimeout(espera.temporizador);
  pendentes.clear();
  assinantes.clear();
  esperandoOla.clear();
  if (limiteDoOla !== null && typeof window !== "undefined") window.clearTimeout(limiteDoOla);
  limiteDoOla = null;
  estado = "pendente";
  iniciada = false;
  motorLocal = false;
  proximoId = 1;
}
