import type { Metadata } from "next";
import { PwaClient } from "./pwa-client";
import { DesktopUpdater } from "./desktop-updater";
import { TvNavigation } from "./tv/tv-navigation";
import { TvAutoReload } from "./tv/tv-auto-reload";
import { TvLayoutFlag } from "./tv/tv-layout-flag";
import "./styles.css";
import "@vidstack/react/player/styles/base.css";
import "@vidstack/react/player/styles/default/theme.css";
// O tema define cores e componentes, mas o posicionamento da barra de vídeo vive neste arquivo
// separado. Sem ele, os controles aparecem soltos em linhas (como na captura antiga).
import "@vidstack/react/player/styles/default/layouts/video.css";

export const metadata: Metadata = {
  title: "OpenCebola",
  description: "Perfis independentes para sua casa",
  applicationName: "OpenCebola",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "OpenCebola" },
  icons: { icon: "/icon.svg", apple: "/icons/cebola-192.png" }
};

/**
 * O tema precisa existir ANTES da primeira pintura, e em toda página.
 *
 * O site é export estático: cada rota é um documento próprio, então um estado de React na home
 * não atravessa para /titulo, /perfis ou /configuracoes — quem escolheu claro voltava ao escuro
 * a cada navegação. Aplicar em efeito também pisca o tema errado por um quadro. Este script roda
 * na análise do documento, antes de qualquer conteúdo aparecer, e é o único lugar que resolve os
 * dois problemas ao mesmo tempo.
 *
 * O "bw" (Preto & Branco) foi retirado: eram só escuro e claro, e o terceiro tema entrou no meio
 * do ciclo do botão. Quem já tinha "bw" salvo volta para o escuro em vez de ficar num tema morto.
 */
const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem("cebola_theme");` +
  `var t=(s==="light"||s==="dark")?s:"dark";` +
  `if(s!==t){localStorage.setItem("cebola_theme",t);}` +
  `document.documentElement.setAttribute("data-theme",t);}` +
  `catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {children}
        <TvLayoutFlag />
        <TvNavigation />
        <TvAutoReload />
        <DesktopUpdater />
        <PwaClient />
      </body>
    </html>
  );
}
