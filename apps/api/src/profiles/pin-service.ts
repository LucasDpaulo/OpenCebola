import {
  Algorithm,
  Version,
  hash,
  verify,
  type Options as Argon2Options
} from "@node-rs/argon2";

const PIN_PATTERN = /^\d{4}$/;
const MINIMUM_PEPPER_BYTES = 32;

/**
 * Parâmetros moderados para uma VM pequena. A operação é rara, assíncrona e
 * limitada a uma thread; o pepper impede ataque offline apenas com um dump do
 * banco, algo especialmente importante para o espaço de somente 10 mil PINs.
 */
export const PIN_ARGON2_OPTIONS: Readonly<Argon2Options> = Object.freeze({
  algorithm: Algorithm.Argon2id,
  version: Version.V0x13,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32
});

export const PIN_ERROR_MESSAGE = "Não foi possível validar o PIN.";

/** Erro público único para formato inválido e PIN incorreto. */
export class PinError extends Error {
  readonly code = "PIN_INVALID" as const;

  constructor() {
    super(PIN_ERROR_MESSAGE);
    this.name = "PinError";
  }
}

export interface PinServiceOptions {
  /** Segredo server-side independente do banco, com no mínimo 256 bits. */
  readonly pepper: Uint8Array;
}

export class PinService {
  private readonly pepper: Uint8Array;

  constructor(options: PinServiceOptions) {
    if (options.pepper.byteLength < MINIMUM_PEPPER_BYTES) {
      throw new TypeError("O pepper de PIN precisa ter pelo menos 32 bytes.");
    }

    // Copia para impedir mutação posterior pelo chamador.
    this.pepper = Uint8Array.from(options.pepper);
  }

  async hashPin(pin: string): Promise<string> {
    this.assertValidFormat(pin);
    return hash(pin, {
      ...PIN_ARGON2_OPTIONS,
      secret: this.pepper
    });
  }

  /**
   * Retorna false para formato, hash ou PIN incorreto, sem revelar qual falhou.
   * Deve ser chamado apenas pela API; PIN e hash nunca seguem ao navegador.
   */
  async verifyPin(pin: string, encodedHash: string): Promise<boolean> {
    if (!PIN_PATTERN.test(pin) || !encodedHash.startsWith("$argon2id$")) {
      return false;
    }

    try {
      return await verify(encodedHash, pin, { secret: this.pepper });
    } catch {
      // Hash corrompido e PIN incorreto permanecem indistinguíveis na borda.
      return false;
    }
  }

  async assertPin(pin: string, encodedHash: string): Promise<void> {
    if (!(await this.verifyPin(pin, encodedHash))) {
      throw new PinError();
    }
  }

  private assertValidFormat(pin: string): void {
    if (!PIN_PATTERN.test(pin)) {
      throw new PinError();
    }
  }
}
