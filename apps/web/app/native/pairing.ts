import { apiFetch, setCredential } from "../api-client";
import { loadToken, saveToken } from "./session-store";

export type PairingTicket = {
  readonly code: string;
  readonly deviceId: string;
  readonly expiresInSeconds: number;
};

export async function requestPairingCode(): Promise<PairingTicket> {
  const response = await apiFetch("/v1/auth/device/code", {
    method: "POST",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error("não foi possível pedir um código");
  const body = await response.json() as Partial<PairingTicket>;
  if (typeof body.code !== "string" || typeof body.deviceId !== "string") {
    throw new Error("resposta de pareamento inválida");
  }
  return {
    code: body.code,
    deviceId: body.deviceId,
    expiresInSeconds: typeof body.expiresInSeconds === "number" ? body.expiresInSeconds : 0
  };
}

/**
 * `null` quer dizer "ainda não aprovaram", que é o caso normal enquanto a pessoa atravessa a
 * sala. Só resposta fora de 200 e 202 é falha de verdade.
 *
 * O 202 do servidor vem **sem corpo** (`reply.code(202).send()`), então a saída acontece
 * antes de qualquer tentativa de ler JSON — ler ali lançaria erro de parse no caso mais
 * comum do laço.
 */
export async function claimSession(ticket: PairingTicket): Promise<string | null> {
  const response = await apiFetch("/v1/auth/device/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code: ticket.code, deviceId: ticket.deviceId })
  });
  if (response.status === 202) return null;
  if (!response.ok) throw new Error("pareamento recusado");
  const body = await response.json() as { token?: unknown };
  const token = typeof body.token === "string" ? body.token : null;
  if (token !== null) {
    saveToken(token);
    setCredential({ kind: "bearer", token });
  }
  return token;
}

/**
 * Chamada uma vez na abertura do app, antes de qualquer tela. Sem ela o aparelho parearia de
 * novo toda vez, e o teto de 20 aparelhos da conta se esgotaria sozinho.
 */
export function restoreSession(): boolean {
  const token = loadToken();
  if (token === null) return false;
  setCredential({ kind: "bearer", token });
  return true;
}
