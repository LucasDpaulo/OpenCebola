"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandIcon } from "../../brand-icon";
import styles from "./page.module.css";
import { apiFetch } from "../../api-client";

type RejectedAddon = { identifier: string; reason: string };
type Status = { linked: boolean; addonCount: number; syncedAt: string | null; rejected?: RejectedAddon[] };
type ViewState = "loading" | "ready" | "error";


function isStatus(value: unknown): value is Status {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Partial<Status>;
  return typeof status.linked === "boolean" &&
    typeof status.addonCount === "number" &&
    (typeof status.syncedAt === "string" || status.syncedAt === null);
}

type DiagnosticsEntry = {
  at: string;
  origin: "servidor" | "aparelho";
  code: string;
  message: string;
  route?: string;
  status?: number;
  detail?: string;
  context?: Record<string, string>;
  device?: string;
};

function isDiagnosticsEntry(value: unknown): value is DiagnosticsEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<DiagnosticsEntry>;
  return typeof entry.at === "string" &&
    (entry.origin === "servidor" || entry.origin === "aparelho") &&
    typeof entry.code === "string" && typeof entry.message === "string";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `DD/MM HH:MM:SS`, o bastante para diferenciar entradas do mesmo dia sem poluir a linha. */
function formatEntryTimestamp(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * Uma linha por entrada, pensada para ser colada direto num chat: quem está na TV não consegue
 * copiar nada de lá, então o dono abre esta tela no PC e cola o texto puro para investigar.
 */
function formatEntryLine(entry: DiagnosticsEntry): string {
  const origin = entry.device ? `${entry.origin}/${entry.device}` : entry.origin;
  const head = [entry.code, entry.status !== undefined ? String(entry.status) : null, entry.route ?? null]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  let line = `${formatEntryTimestamp(entry.at)} [${origin}] ${head}`;
  if (entry.message) line += ` — ${entry.message}`;
  if (entry.detail) line += ` | ${entry.detail}`;
  if (entry.context) {
    const pairs = Object.entries(entry.context).map(([key, value]) => `${key}=${value}`).join(" ");
    if (pairs) line += ` | ${pairs}`;
  }
  return line;
}

function DiagnosticsPanel() {
  const [entries, setEntries] = useState<DiagnosticsEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copiar");
  const [error, setError] = useState<string | null>(null);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/v1/stremio/diagnostics", {
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("diagnostics unavailable");
      const body = await response.json() as { entries?: unknown };
      setEntries(Array.isArray(body.entries) ? body.entries.filter(isDiagnosticsEntry) : []);
    } catch {
      setError("Não foi possível carregar o registro agora.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (fallbackText === null) return;
    fallbackRef.current?.focus();
    fallbackRef.current?.select();
  }, [fallbackText]);

  async function copyAll() {
    if (!entries || entries.length === 0) return;
    const text = entries.map(formatEntryLine).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setFallbackText(null);
      setCopyLabel("Copiado.");
      window.setTimeout(() => setCopyLabel("Copiar"), 3_000);
    } catch {
      // Sem permissão/API de clipboard (comum em TV): deixa o texto numa caixa somente leitura
      // já selecionada, para copiar manualmente com o que o aparelho tiver.
      setFallbackText(text);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/v1/stremio/diagnostics", { method: "DELETE" });
      if (!response.ok) throw new Error("clear failed");
      setEntries([]);
      setFallbackText(null);
    } catch {
      setError("Não foi possível limpar o registro agora.");
    } finally {
      setBusy(false);
    }
  }

  const hasEntries = entries !== null && entries.length > 0;

  return (
    <section className={styles.panel}>
      <p className={styles.eyebrow}>Diagnóstico</p>
      <h1>Registro de erros</h1>
      <p className={styles.copy}>
        Últimos erros de reprodução e addons de todos os aparelhos da casa. Some quando o servidor é atualizado.
      </p>
      <div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => void load()}>Atualizar</button>
        <button type="button" disabled={busy || !hasEntries} onClick={() => void copyAll()}>{copyLabel}</button>
        <button type="button" className={styles.danger} disabled={busy || !hasEntries} onClick={() => void clear()}>Limpar</button>
      </div>
      {error ? <p role="status" className={styles.message}>{error}</p> : null}
      {fallbackText !== null ? (
        <div className={styles.diagnosticsFallback}>
          <p className={styles.copy}>O navegador não permitiu copiar automaticamente. Selecione e copie manualmente:</p>
          <textarea
            ref={fallbackRef}
            readOnly
            value={fallbackText}
            className={styles.diagnosticsTextarea}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
      {entries === null ? null : entries.length === 0 ? (
        <p className={styles.copy}>Nenhum erro registrado.</p>
      ) : (
        <ul className={styles.diagnosticsList}>
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={styles.diagnosticsItem}>
              <div className={styles.diagnosticsHead}>
                <span>{formatEntryTimestamp(entry.at)}</span>
                <span>{entry.device ? `${entry.origin}/${entry.device}` : entry.origin}</span>
                <code>{entry.code}</code>
                {entry.status !== undefined ? <span>{entry.status}</span> : null}
                {entry.route ? <span className={styles.diagnosticsRoute}>{entry.route}</span> : null}
              </div>
              {entry.message ? <p className={styles.diagnosticsMessage}>{entry.message}</p> : null}
              {entry.detail ? <code className={styles.diagnosticsDetail}>{entry.detail}</code> : null}
              {entry.context && Object.keys(entry.context).length > 0 ? (
                <p className={styles.diagnosticsContext}>
                  {Object.entries(entry.context).map(([key, value]) => `${key}=${value}`).join(" ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function StremioSettings() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [adminUnlocked, setAdminUnlocked] = useState(false);

  const load = useCallback(async () => {
    setViewState("loading");
    try {
      const response = await apiFetch(`/v1/stremio/status`, {
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      if (response.status === 401) {
        router.replace("/entrar");
        return;
      }
      if (response.status === 409) {
        router.replace("/perfis/index.html");
        return;
      }
      if (!response.ok) throw new Error("status unavailable");
      const body = await response.json() as unknown;
      if (!isStatus(body)) throw new Error("invalid status");
      setStatus(body);
      setViewState("ready");
    } catch {
      setViewState("error");
    }
  }, [router]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await apiFetch("/v1/stremio/admin", { cache: "no-store", headers: { Accept: "application/json" } });
        if (response.status === 401) { router.replace("/entrar"); return; }
        const body = await response.json() as { unlocked?: unknown };
        if (body.unlocked === true) { setAdminUnlocked(true); await load(); }
        else setViewState("ready");
      } catch { setViewState("error"); }
    })();
  }, [load, router]);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/v1/stremio/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ password: adminPassword })
      });
      if (!response.ok) throw new Error("locked");
      setAdminPassword("");
      setAdminUnlocked(true);
      await load();
    } catch {
      setAdminPassword("");
      setMessage("Senha incorreta.");
    } finally { setBusy(false); }
  }

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/v1/stremio/link`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (response.status === 401) {
        router.replace("/entrar");
        return;
      }
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok || !isStatus(body)) throw new Error("link failed");
      setPassword("");
      setEmail("");
      setStatus(body);
      setMessage("Conta vinculada em modo somente leitura.");
    } catch {
      setPassword("");
      setMessage("Não foi possível vincular. Confira o e-mail e a nova senha do Stremio.");
    } finally {
      setBusy(false);
    }
  }

  async function mutate(action: "sync" | "disconnect") {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(
        action === "sync" ? "/v1/stremio/sync" : "/v1/stremio/link",
        {
          method: action === "sync" ? "POST" : "DELETE",
          headers: { Accept: "application/json" }
        }
      );
      if (!response.ok) throw new Error("mutation failed");
      if (action === "disconnect") {
        setStatus({ linked: false, addonCount: 0, syncedAt: null });
        setMessage("Vínculo removido somente do Cebola. Seus addons Stremio não foram alterados.");
      } else {
        const body = await response.json() as unknown;
        if (!isStatus(body)) throw new Error("invalid response");
        setStatus(body);
        setMessage("Coleção consultada novamente, sem modificar o Stremio.");
      }
    } catch {
      setMessage("Não foi possível concluir a operação.");
    } finally {
      setBusy(false);
    }
  }

  if (viewState === "loading") return <main className={styles.state}>Carregando integração…</main>;
  if (viewState === "error") {
    return <main className={styles.state}><p>Não foi possível carregar.</p><button onClick={() => void load()}>Tentar novamente</button></main>;
  }

  if (!adminUnlocked) return (
    <main className={styles.page}>
      <header className={styles.header}><a href="/" className={styles.brand} aria-label="Início"><BrandIcon size={32} /></a><a href="/">Voltar ao início</a></header>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>Área protegida</p>
        <h1>Configuração do Stremio</h1>
        <p className={styles.copy}>Digite a senha administrativa para continuar.</p>
        <form onSubmit={unlock} className={styles.form}>
          <label>Senha administrativa<input type="password" autoComplete="current-password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} required maxLength={128} autoFocus /></label>
          <button disabled={busy} type="submit">{busy ? "Verificando…" : "Entrar"}</button>
        </form>
        {message ? <p role="status" className={styles.message}>{message}</p> : null}
      </section>
    </main>
  );

  if (status === null) return <main className={styles.state}>Carregando integração…</main>;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a href="/" className={styles.brand} aria-label="Início">
          <BrandIcon size={32} />
        </a>
        <a href="/">Voltar ao início</a>
      </header>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>Motor de conteúdo</p>
        <h1>Conta Stremio</h1>
        <p className={styles.copy}>
          O Cebola consulta seus addons existentes. Ele não instala, remove, reordena ou altera nada na sua conta Stremio.
        </p>

        {status.linked ? (
          <div className={styles.connected}>
            <strong>Conta vinculada</strong>
            <span>{status.addonCount} addons HTTPS compatíveis encontrados</span>
            {status.rejected && status.rejected.length > 0 ? (
              <details className={styles.rejected}>
                <summary>
                  {status.rejected.length} addon{status.rejected.length > 1 ? "s" : ""} da sua conta não pôde ser usado
                </summary>
                <ul>
                  {status.rejected.map((addon) => (
                    <li key={`${addon.identifier}:${addon.reason}`}>
                      <strong>{addon.identifier}</strong> — {addon.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <span>{status.syncedAt ? `Última consulta: ${new Date(status.syncedAt).toLocaleString("pt-BR")}` : ""}</span>
            <div className={styles.actions}>
              <button disabled={busy} onClick={() => void mutate("sync")}>Consultar novamente</button>
              <button className={styles.danger} disabled={busy} onClick={() => void mutate("disconnect")}>Desvincular</button>
            </div>
          </div>
        ) : (
          <form onSubmit={link} className={styles.form}>
            <label>E-mail do Stremio<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></label>
            <label>Senha atual do Stremio<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={1024} /></label>
            <p>A senha é enviada por HTTPS somente para criar a sessão e é descartada imediatamente. Apenas o token fica cifrado na Oracle/Supabase.</p>
            <button disabled={busy} type="submit">{busy ? "Vinculando…" : "Vincular em modo leitura"}</button>
          </form>
        )}
        {message ? <p role="status" className={styles.message}>{message}</p> : null}
      </section>
      <DiagnosticsPanel />
    </main>
  );
}
