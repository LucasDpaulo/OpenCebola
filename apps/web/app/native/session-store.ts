const CHAVE = "cebola.sessao";

/**
 * `localStorage` e não cookie, porque no app não existe cookie — e é exatamente por não
 * existir que o `Authorization` é seguro aqui: nenhum navegador o anexa sozinho, então não
 * há CSRF a defender.
 *
 * Cada acesso é protegido: a WebView pode estar com armazenamento desligado, e nesse caso o
 * app deve cair no pareamento em vez de quebrar na abertura.
 */
export function saveToken(token: string): void {
  try { window.localStorage.setItem(CHAVE, token); } catch { /* sem armazenamento */ }
}

export function loadToken(): string | null {
  try { return window.localStorage.getItem(CHAVE); } catch { return null; }
}

export function clearToken(): void {
  try { window.localStorage.removeItem(CHAVE); } catch { /* sem armazenamento */ }
}
