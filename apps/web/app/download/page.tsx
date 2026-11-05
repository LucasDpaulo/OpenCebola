import type { Metadata } from "next";
import { BrandIcon } from "../brand-icon";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Aplicativos · OpenCebola",
  description: "Compile e instale os aplicativos da sua própria instância OpenCebola."
};

export default function DownloadPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}><a href="/" aria-label="Voltar"><BrandIcon size={38} /></a></header>
      <section className={styles.card}>
        <span className={styles.kicker}>Sua instalação</span>
        <h1>Aplicativos OpenCebola</h1>
        <p>Execute localmente ou use a infraestrutura que preferir. Os aplicativos devem apontar para a sua própria instância.</p>
        <section className={styles.platform}>
          <h2>Preparar os aplicativos</h2>
          <p>No código-fonte, siga docs/PLATAFORMAS.md para Android, Android TV, Linux, Windows, iOS, Samsung Tizen e Roku. Os requisitos e o estado de validação variam por plataforma.</p>
          <pre className={styles.command}><code>npm run native:configure</code></pre>
          <p>Use os pacotes produzidos pela sua instalação. Esta base não inclui binários publicados nem um canal central de atualizações.</p>
        </section>
        <section className={styles.platform}>
          <h2>Conta e addons</h2>
          <p>Conecte sua conta em Configurar Stremio. Os addons e serviços externos são escolhidos por você; integrações não concedem direitos sobre os conteúdos.</p>
        </section>
      </section>
      <footer className={styles.footer}><a href="/licencas/index.html">Licenças dos componentes</a></footer>
    </main>
  );
}
