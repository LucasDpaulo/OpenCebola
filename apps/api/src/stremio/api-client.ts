import { addonCollectionSchema, StremioIntegrationError, type AddonDescriptor } from "./types.js";

const STREMIO_API_ENDPOINT = "https://api.strem.io/api";
const MAX_RESPONSE_BYTES = 1_048_576;

interface ApiEnvelope {
  readonly result?: unknown;
  readonly error?: unknown;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new StremioIntegrationError("INVALID_RESPONSE");
  }
  if (response.body === null) throw new StremioIntegrationError("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new StremioIntegrationError("INVALID_RESPONSE");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new StremioIntegrationError("INVALID_RESPONSE");
  }
}

// Add-on descartado por supportedDescriptors: motivo curto para diagnóstico, sem nenhum dado
// sensível. "identifier" nunca é a transportUrl (carrega a chave de debrid do usuário) — é o
// melhor rótulo disponível no manifesto, com fallback para um marcador genérico.
export interface RejectedAddon {
  readonly identifier: string;
  readonly reason: string;
}

function rejectedIdentifier(candidate: unknown): string {
  const manifest = typeof candidate === "object" && candidate !== null
    ? (candidate as { readonly manifest?: unknown }).manifest
    : undefined;
  const info = typeof manifest === "object" && manifest !== null
    ? manifest as { readonly name?: unknown; readonly id?: unknown }
    : undefined;
  if (typeof info?.name === "string" && info.name.trim() !== "") return info.name.trim().slice(0, 200);
  if (typeof info?.id === "string" && info.id.trim() !== "") return info.id.trim().slice(0, 200);
  return "add-on desconhecido";
}

function supportedDescriptors(
  value: unknown,
  onRejected?: (rejected: RejectedAddon) => void
): readonly AddonDescriptor[] {
  if (!Array.isArray(value)) throw new StremioIntegrationError("INVALID_RESPONSE");
  const accepted: AddonDescriptor[] = [];
  for (const candidate of value.slice(0, 100)) {
    const parsed = addonCollectionSchema.element.safeParse(candidate);
    if (!parsed.success) {
      // Mensagem do primeiro issue do Zod descreve o formato do manifesto (ex.: "manifest.
      // catalogs.0.type: Invalid enum value..."); nunca inclui transportUrl.
      const issue = parsed.error.issues[0];
      onRejected?.({
        identifier: rejectedIdentifier(candidate),
        reason: (issue ? `${issue.path.join(".")}: ${issue.message}` : "formato inválido").slice(0, 300)
      });
      continue;
    }
    try {
      const transport = new URL(parsed.data.transportUrl);
      if (
        transport.protocol !== "https:" ||
        transport.username !== "" ||
        transport.password !== "" ||
        !transport.pathname.endsWith("/manifest.json")
      ) {
        onRejected?.({
          identifier: rejectedIdentifier(candidate),
          reason: "transportUrl fora da política (https, sem credenciais, terminando em /manifest.json)"
        });
        continue;
      }
      accepted.push(parsed.data);
    } catch {
      onRejected?.({ identifier: rejectedIdentifier(candidate), reason: "transportUrl inválida" });
      continue;
    }
  }
  return addonCollectionSchema.parse(accepted);
}

export interface StremioLoginResult {
  readonly authKey: string;
  readonly addons: readonly AddonDescriptor[];
}

export class StremioApiClient {
  async #request(method: string, parameters: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${STREMIO_API_ENDPOINT}/${method}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(parameters),
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) throw new StremioIntegrationError("UPSTREAM_UNAVAILABLE");
      const payload = await readBoundedJson(response);
      if (typeof payload !== "object" || payload === null) {
        throw new StremioIntegrationError("INVALID_RESPONSE");
      }
      const envelope = payload as ApiEnvelope;
      if (envelope.error !== undefined) {
        // O upstream avaliou e rejeitou a chamada (ex.: credenciais recusadas no login).
        throw new StremioIntegrationError("AUTHENTICATION_FAILED");
      }
      if (envelope.result === undefined) {
        // 200 sem "result" nem "error": mudança de formato do upstream, não credencial errada.
        throw new StremioIntegrationError("INVALID_RESPONSE");
      }
      return envelope.result;
    } catch (error) {
      if (error instanceof StremioIntegrationError) throw error;
      throw new StremioIntegrationError("UPSTREAM_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }

  async login(
    email: string,
    password: string,
    onRejected?: (rejected: RejectedAddon) => void
  ): Promise<StremioLoginResult> {
    const result = await this.#request("login", { authKey: null, email, password });
    const authKey = typeof result === "object" && result !== null
      ? (result as { readonly authKey?: unknown }).authKey
      : undefined;
    if (typeof authKey !== "string" || authKey.length < 16 || authKey.length > 4_096) {
      // O upstream aceitou o login mas não devolveu um authKey utilizável: formato, não credencial.
      throw new StremioIntegrationError("INVALID_RESPONSE");
    }
    const addons = await this.pullAddons(authKey, onRejected);
    return { authKey, addons };
  }

  async pullAddons(
    authKey: string,
    onRejected?: (rejected: RejectedAddon) => void
  ): Promise<readonly AddonDescriptor[]> {
    const result = await this.#request("addonCollectionGet", {
      authKey,
      update: false,
      addFromURL: []
    });
    const addons = typeof result === "object" && result !== null
      ? (result as { readonly addons?: unknown }).addons
      : undefined;
    return supportedDescriptors(addons, onRejected);
  }
}
