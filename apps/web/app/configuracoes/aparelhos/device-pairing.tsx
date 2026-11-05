"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandIcon } from "../../brand-icon";
import styles from "./page.module.css";
import { apiFetch } from "../../api-client";


// Mesmo alfabeto de `devicePairingCodeSchema` em @cebola/contracts. Ele exclui de propósito
// I, O, 0 e 1: o código é lido numa TV, do outro lado da sala, e digitado aqui — as duas
// confusões clássicas de leitura à distância não podem sequer existir.
const ALFABETO = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;
const TAMANHO = 6;

type Resultado = { tipo: "ok" | "erro"; texto: string };

export function DevicePairing() {
  const router = useRouter();
  const [codigo, setCodigo] = useState("");
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  // Filtra enquanto digita em vez de recusar no envio: quem errou um caractere descobre na
  // hora, e não depois de atravessar a sala para conferir a TV de novo.
  function digitar(valor: string) {
    setCodigo(valor.toUpperCase().replace(ALFABETO, "").slice(0, TAMANHO));
    setResultado(null);
  }

  async function aprovar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setResultado(null);
    try {
      const response = await apiFetch(`/v1/auth/device/approve`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code: codigo })
      });
      if (response.status === 401) {
        router.replace("/entrar");
        return;
      }
      if (response.status === 204) {
        setCodigo("");
        setResultado({ tipo: "ok", texto: "Aparelho liberado. Ele deve entrar sozinho em alguns segundos." });
        return;
      }
      // A API responde igual para código inexistente e código expirado, de propósito: confirmar
      // que um código existe entregaria a quem está adivinhando a informação de que acertou o
      // formato. Então a mensagem aqui também precisa cobrir os dois casos.
      if (response.status === 404) {
        setResultado({ tipo: "erro", texto: "Código não encontrado ou já expirado. Peça um novo no aparelho." });
        return;
      }
      if (response.status === 403) {
        setResultado({ tipo: "erro", texto: "A aprovação precisa ser feita pelo site, num navegador." });
        return;
      }
      setResultado({ tipo: "erro", texto: "Não foi possível aprovar. Confira o código e tente de novo." });
    } catch {
      setResultado({ tipo: "erro", texto: "Não foi possível falar com o servidor." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a href="/" className={styles.brand} aria-label="Início">
          <BrandIcon size={32} />
        </a>
        <a href="/">Voltar ao início</a>
      </header>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>Aparelhos</p>
        <h1>Parear aparelho</h1>
        <p className={styles.copy}>
          Abra o Cebola na TV ou no celular. Ele mostra um código de {TAMANHO} caracteres.
          Digite esse código aqui para liberar o aparelho na sua conta.
        </p>

        <form onSubmit={aprovar} className={styles.form}>
          <label htmlFor="codigo">Código mostrado no aparelho</label>
          <input
            id="codigo"
            className={styles.codigo}
            value={codigo}
            onChange={(event) => digitar(event.target.value)}
            // Teclado de letras no celular, e sem correções do sistema: o campo não é palavra.
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="one-time-code"
            placeholder="ABC234"
            aria-describedby="ajuda-codigo"
            required
          />
          <p id="ajuda-codigo">
            O código vale por poucos minutos e serve uma vez só. Se expirar, peça outro no
            próprio aparelho.
          </p>
          <button type="submit" disabled={busy || codigo.length < TAMANHO}>
            {busy ? "Liberando…" : "Liberar aparelho"}
          </button>
        </form>

        {resultado ? (
          <p
            role="status"
            className={resultado.tipo === "ok" ? styles.sucesso : styles.erro}
          >
            {resultado.texto}
          </p>
        ) : null}
      </section>
    </main>
  );
}
