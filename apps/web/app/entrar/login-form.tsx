"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { apiFetch, isNativeRuntime, setCredential } from "../api-client";
import { saveToken } from "../native/session-store";

const NEUTRAL_AUTH_ERROR = "Não foi possível entrar com os dados informados. Confira e tente novamente.";

type LoginResponse = {
  user: { email: string };
  expiresAt: string;
  activeProfileId: string | null;
};

type DeviceLoginResponse = {
  token: string;
  expiresAt: string;
  session: LoginResponse;
};

export function LoginForm() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    if (!form.checkValidity()) {
      form.reportValidity();
      setMessage(NEUTRAL_AUTH_ERROR);
      return;
    }

    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");

    setIsLoading(true);
    setMessage("");

    try {
      const native = isNativeRuntime();
      const response = await apiFetch(native ? `/v1/auth/device/login` : `/v1/auth/login`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      if (!response.ok) {
        setMessage(NEUTRAL_AUTH_ERROR);
        return;
      }

      const body = (await response.json()) as LoginResponse | DeviceLoginResponse;
      const session = native ? (body as DeviceLoginResponse).session : (body as LoginResponse);
      if (native) {
        const token = (body as DeviceLoginResponse).token;
        if (typeof token !== "string" || token.length === 0) {
          setMessage(NEUTRAL_AUTH_ERROR);
          return;
        }
        saveToken(token);
        setCredential({ kind: "bearer", token });
      }
      if (!session.user?.email || !session.expiresAt) {
        setMessage(NEUTRAL_AUTH_ERROR);
        return;
      }

      form.reset();
      router.replace("/perfis/index.html");
    } catch {
      setMessage(NEUTRAL_AUTH_ERROR);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className={styles.cardContainer}>
      <form
        className={styles.loginCard}
        onSubmit={handleSubmit}
        aria-busy={isLoading}
      >
        <div className={styles.cardHeader}>
          <span className={styles.cardTag}>Acesso à casa</span>
          <h2>Entrar</h2>
        </div>

        <div className={styles.field}>
          <label htmlFor="house-email">E-mail</label>
          <div className={styles.inputWrapper}>
            <input
              id="house-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="seu@email.com"
              required
              autoFocus
              disabled={isLoading}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label htmlFor="house-password">Senha</label>
          <div className={styles.passwordField}>
            <input
              id="house-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Digite sua senha"
              required
              disabled={isLoading}
            />
            <button
              className={styles.passwordToggle}
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-pressed={showPassword}
              aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
              disabled={isLoading}
            >
              {showPassword ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {message && (
          <div className={styles.formMessage} role="status" aria-live="polite">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{message}</span>
          </div>
        )}

        <button className={styles.submitButton} type="submit" disabled={isLoading}>
          <span>{isLoading ? "Entrando…" : "Entrar"}</span>
          {isLoading ? (
            <span className={styles.loadingIndicator} aria-hidden="true" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          )}
        </button>
      </form>
    </div>
  );
}
