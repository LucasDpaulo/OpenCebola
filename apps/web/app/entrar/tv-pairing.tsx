"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { requestPairingCode, claimSession, type PairingTicket } from "../native/pairing";

// Onde a pessoa aprova o código, no celular. Mesma central que já existe para outros aparelhos.
const APPROVE_PATH = "/configuracoes/aparelhos";
// Só o host, sem esquema, para caber na TV sem o usuário digitar "https://".
const APPROVE_HINT = (process.env.NEXT_PUBLIC_OPENCEBOLA_WEB_URL ?? "http://localhost:3000") + APPROVE_PATH;
// A cada quanto tempo perguntamos ao servidor se já aprovaram.
const POLL_MS = 3_000;
// Piso de validade caso o servidor não informe (resposta sem `expiresInSeconds`): evita expirar
// na hora por um campo ausente, sem inventar uma validade longa demais.
const FALLBACK_TTL_SECONDS = 300;

type State =
  | { kind: "loading" }
  | { kind: "waiting"; code: string }
  | { kind: "expired" }
  | { kind: "error" };

function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Se o efeito for desmontado durante a espera, não seguramos o resolve pendurado.
    if (cancelled()) { clearTimeout(timer); resolve(); }
  });
}

/**
 * Pareamento por celular na TV: dentro do WGT o app usa Bearer (não cookie), então a entrada é
 * mostrar um código aqui e aprovar no celular — sem digitar e-mail/senha no controle. Reusa os
 * helpers de `native/pairing.ts`, que já guardam a sessão ao aprovar.
 */
export function TvPairing({ onUseCredentials }: { onUseCredentials: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setState({ kind: "loading" });
      try {
        const ticket: PairingTicket = await requestPairingCode();
        if (cancelled) return;
        setState({ kind: "waiting", code: ticket.code });
        const ttl = ticket.expiresInSeconds > 0 ? ticket.expiresInSeconds : FALLBACK_TTL_SECONDS;
        const expiresAt = Date.now() + ttl * 1_000;

        while (!cancelled && Date.now() < expiresAt) {
          const token = await claimSession(ticket);
          if (cancelled) return;
          if (token !== null) {
            router.replace("/perfis/index.html");
            return;
          }
          await sleep(POLL_MS, () => cancelled);
        }
        if (!cancelled) setState({ kind: "expired" });
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    }

    void run();
    return () => { cancelled = true; };
  }, [attempt, router]);

  return (
    <div className={styles.cardContainer}>
      <div className={styles.loginCard}>
        <div className={styles.cardHeader}>
          <span className={styles.cardTag}>Conectar esta TV</span>
          <h2>Use o celular</h2>
        </div>

        {state.kind === "waiting" ? (
          <>
            <ol className={styles.pairingSteps}>
              <li>No celular, abra <strong>{APPROVE_HINT}</strong></li>
              <li>Digite este código:</li>
            </ol>
            <div className={styles.pairingCode} aria-label={`Código ${state.code}`}>{state.code}</div>
            <p className={styles.pairingStatus} role="status" aria-live="polite">Aguardando aprovação…</p>
            <button type="button" className={styles.pairingButton} onClick={() => setAttempt((n) => n + 1)}>
              Gerar outro código
            </button>
          </>
        ) : state.kind === "expired" ? (
          <>
            <p className={styles.pairingStatus}>O código expirou.</p>
            <button type="button" className={styles.pairingButton} autoFocus onClick={() => setAttempt((n) => n + 1)}>
              Gerar outro código
            </button>
          </>
        ) : state.kind === "error" ? (
          <>
            <p className={styles.pairingStatus}>Não foi possível gerar o código. Confira a conexão da TV.</p>
            <button type="button" className={styles.pairingButton} autoFocus onClick={() => setAttempt((n) => n + 1)}>
              Tentar de novo
            </button>
          </>
        ) : (
          <p className={styles.pairingStatus} role="status" aria-live="polite">Gerando código…</p>
        )}

        <button type="button" className={styles.pairingSecondary} onClick={onUseCredentials}>
          Entrar com e-mail e senha
        </button>
      </div>
    </div>
  );
}
