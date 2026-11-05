"use client";

import { useState } from "react";
import { BrandIcon } from "../../brand-icon";
import styles from "./page.module.css";
import { rokuInstallerUrl } from "./roku-installer";

type Platform = "samsung" | "roku";

const samsungSteps = [
  ["Confirme o modelo", "Na TV, abra Configurações → Suporte → Sobre esta TV e anote o código completo do modelo."],
  ["Ative o modo desenvolvedor", "Abra Apps → Configurações dos Apps, digite 12345, ative Developer Mode e informe o IP do computador."],
  ["Reinicie a televisão", "Desligue completamente a TV e ligue novamente. A TV e o computador precisam estar na mesma rede."],
  ["Instale pelo computador", "No período de testes, o pacote .wgt assinado é enviado pelo computador com o Tizen Studio. Quando publicado, a instalação será feita pela Samsung Apps."],
  ["Conecte sua conta", "Abra o Cebola instalado, veja o código de seis caracteres e use o botão Parear TV nesta página."],
  ["Receba atualizações", "Versões da loja substituem a anterior automaticamente. Arquivos antigos não ficam acumulados no aparelho."]
] as const;

const rokuSteps = [
  ["Ative o Developer Mode", "No controle, use a sequência Home 3x, Cima 2x, Direita, Esquerda, Direita, Esquerda, Direita e anote o IP mostrado."],
  ["Defina a senha", "Aceite os termos do instalador de desenvolvimento, reinicie o Roku e crie a senha solicitada pelo aparelho. O Cebola não pede nem guarda essa senha."],
  ["Abra o instalador pelo celular", "No celular na mesma rede Wi-Fi, use o campo abaixo para abrir o IP do Roku. No instalador, entre com o usuário rokudev."],
  ["Envie o pacote", "Selecione o arquivo cebola-roku.zip baixado no celular e clique em Install. Uma nova versão substitui somente o canal de desenvolvimento anterior."],
  ["Conecte sua conta", "Abra o canal Cebola, copie o código mostrado e use o botão Parear TV nesta página."],
  ["Atualize pelo mesmo fluxo", "Para atualizar durante os testes, baixe o pacote novo, abra novamente o instalador e envie o ZIP. Na distribuição oficial, a Roku Channel Store passa a cuidar das atualizações."]
] as const;

export function TvInstallGuide() {
  const [platform, setPlatform] = useState<Platform>("samsung");
  const [rokuIp, setRokuIp] = useState("");
  const [rokuSubmitted, setRokuSubmitted] = useState(false);
  const steps = platform === "samsung" ? samsungSteps : rokuSteps;
  const rokuUrl = rokuInstallerUrl(rokuIp);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a href="/" className={styles.brand} aria-label="Início"><BrandIcon size={34} /></a>
        <div><a href="/">Início</a><a href="/perfis/index.html">Perfis</a></div>
      </header>

      <section className={styles.hero}>
        <p className={styles.eyebrow}>Configurações do perfil</p>
        <h1>Instalar em uma TV</h1>
        <p>Use a mesma interface do Cebola que você já conhece, instalada como aplicativo e adaptada para o controle remoto.</p>
      </section>

      <nav className={styles.platforms} aria-label="Escolher sistema da TV">
        <button type="button" aria-pressed={platform === "samsung"} onClick={() => setPlatform("samsung")}>
          <strong>Samsung</strong><span>Tizen · modelos recentes</span>
        </button>
        <button type="button" aria-pressed={platform === "roku"} onClick={() => setPlatform("roku")}>
          <strong>Roku</strong><span>Roku OS · modelos recentes</span>
        </button>
      </nav>

      <section className={styles.status} aria-label="Estado da versão para TV">
        <div><span>Plataforma selecionada</span><strong>{platform === "samsung" ? "Samsung Tizen" : "Roku OS"}</strong></div>
        <div><span>Distribuição atual</span><strong className={styles.development}>Em desenvolvimento</strong></div>
        <p>{platform === "samsung"
          ? "O site orienta e faz o pareamento. Durante os testes, a instalação na Samsung continua dependente de um computador com Tizen Studio."
          : "No Roku, baixe o pacote no celular e abra o instalador de desenvolvimento pela sua rede Wi-Fi."}</p>
      </section>

      <section className={styles.guide} aria-labelledby="guide-title">
        <div className={styles.guideHeading}>
          <div><p className={styles.eyebrow}>Passo a passo</p><h2 id="guide-title">{platform === "samsung" ? "Instalação na Samsung" : "Instalação na Roku"}</h2></div>
          <a className={styles.pairButton} href="/configuracoes/aparelhos">Parear TV</a>
        </div>
        {platform === "roku" ? (
          <section className={styles.rokuInstaller} aria-labelledby="roku-installer-title">
            <div>
              <p className={styles.eyebrow}>Instalação pelo celular</p>
              <h3 id="roku-installer-title">Envie o Cebola pela sua rede Wi-Fi</h3>
              <p>O pacote atual é de desenvolvimento e substitui somente o canal de desenvolvimento já instalado.</p>
            </div>
            <a className={styles.downloadButton} href="/downloads/cebola-roku.zip" download="cebola-roku.zip">Baixar pacote Roku</a>
            <form onSubmit={(event) => { event.preventDefault(); setRokuSubmitted(true); }}>
              <label htmlFor="roku-ip">IP mostrado pela Roku</label>
              <div className={styles.ipControls}>
                <input
                  id="roku-ip"
                  inputMode="decimal"
                  placeholder="192.168.1.45"
                  value={rokuIp}
                  onChange={(event) => { setRokuIp(event.target.value); setRokuSubmitted(false); }}
                  aria-describedby={rokuSubmitted && !rokuUrl ? "roku-ip-error" : undefined}
                />
                <button type="submit">Continuar</button>
              </div>
              {rokuSubmitted && !rokuUrl ? <p id="roku-ip-error" role="alert">Digite o IPv4 privado mostrado pela Roku.</p> : null}
            </form>
            {rokuSubmitted && rokuUrl ? <a className={styles.openButton} href={rokuUrl} target="_blank" rel="noreferrer">Abrir instalador da Roku</a> : null}
          </section>
        ) : null}
        <ol className={styles.steps}>
          {steps.map(([title, description], index) => (
            <li key={title}><span>{index + 1}</span><div><h3>{title}</h3><p>{description}</p></div></li>
          ))}
        </ol>
      </section>

      <aside className={styles.help}>
        <strong>Antes de começar</strong>
        <p>{platform === "samsung"
          ? "Tenha o código completo do modelo, o IP da TV e um computador conectado à mesma rede. Certificados, senhas e chaves de assinatura nunca são enviados por esta página."
          : "Tenha o IP do Roku e o celular conectados à mesma rede Wi-Fi. A senha de desenvolvedor fica somente no instalador da Roku; o Cebola não a pede nem armazena."}</p>
      </aside>
    </main>
  );
}
