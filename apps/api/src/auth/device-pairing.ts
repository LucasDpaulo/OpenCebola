import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Sem O, 0, I e 1: alguém vai ler este código de longe, na tela da TV. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING = 500;

export interface DevicePairingTicket {
  readonly code: string;
  /** Segredo que só o aparelho conhece. Nunca aparece na tela. */
  readonly deviceId: string;
  readonly expiresAt: Date;
}

export type DevicePairingClaim =
  | { readonly status: "pending" }
  | {
      readonly status: "approved";
      readonly userId: string;
      /**
       * Recoloca este mesmo bilhete no mapa. Existe porque emitir a sessão é a única parte
       * demorada do fluxo e pode falhar depois que o bilhete já saiu: sem devolver, um piscar
       * do Supabase apagaria um código que a pessoa acabou de ver aprovar, e a próxima consulta
       * do laço responderia 404 sem explicação nenhuma.
       *
       * É um fechamento sobre o registro consumido, e não um método público que aceite dados
       * quaisquer, para que ninguém possa reinserir um bilhete que não foi consumido aqui.
       */
      readonly restore: (now: Date) => void;
    }
  | { readonly status: "unknown" };

export interface DevicePairingStoreOptions {
  readonly ttlMs?: number;
  readonly maxPending?: number;
}

interface PendingPairing {
  readonly deviceIdHash: Buffer;
  readonly expiresAt: number;
  userId: string | null;
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Vive só em memória, de propósito. O código dura 10 minutos e a API roda numa instância só;
 * uma tabela no banco custaria migração e limpeza para guardar algo que morre sozinho. Reinício
 * durante um pareamento em andamento apenas obriga a pessoa a pedir outro código.
 */
export class DevicePairingStore {
  readonly #pending = new Map<string, PendingPairing>();
  readonly #ttlMs: number;
  readonly #maxPending: number;

  constructor(options: DevicePairingStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  create(now: Date): DevicePairingTicket {
    this.#sweep(now);
    if (this.#pending.size >= this.#maxPending) {
      throw new Error("Limite de pareamentos pendentes atingido.");
    }

    let code = this.#randomCode();
    // Colisão é rara em 32^6, mas um código repetido entregaria a sessão errada.
    while (this.#pending.has(code)) code = this.#randomCode();

    const deviceId = randomBytes(24).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.#ttlMs);
    this.#pending.set(code, {
      deviceIdHash: hash(deviceId),
      expiresAt: expiresAt.getTime(),
      userId: null
    });
    return { code, deviceId, expiresAt };
  }

  approve(code: string, userId: string, now: Date): boolean {
    this.#sweep(now);
    const entry = this.#pending.get(code);
    if (!entry) return false;
    entry.userId = userId;
    return true;
  }

  claim(code: string, deviceId: string, now: Date): DevicePairingClaim {
    this.#sweep(now);
    const entry = this.#pending.get(code);
    if (!entry) return { status: "unknown" };
    // Comparação de tempo constante: o deviceId é o que impede quem leu o código de reivindicar.
    if (!timingSafeEqual(entry.deviceIdHash, hash(deviceId))) return { status: "unknown" };
    if (entry.userId === null) return { status: "pending" };
    // Uso único: o bilhete sai do mapa AQUI, antes de o chamador ir emitir a sessão. Consumir
    // só depois abriria uma janela em que duas consultas simultâneas viram duas sessões.
    this.#pending.delete(code);
    return {
      status: "approved",
      userId: entry.userId,
      restore: (moment: Date) => {
        // Não ressuscita bilhete vencido, nem atropela um código que tenha sido reemitido
        // enquanto a emissão da sessão estava em andamento.
        if (entry.expiresAt <= moment.getTime()) return;
        if (this.#pending.has(code)) return;
        this.#pending.set(code, entry);
      }
    };
  }

  #randomCode(): string {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
    return code;
  }

  #sweep(now: Date): void {
    const instant = now.getTime();
    for (const [code, entry] of this.#pending) {
      if (entry.expiresAt <= instant) this.#pending.delete(code);
    }
  }
}
