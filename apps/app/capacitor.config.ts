import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.opencebola.app",
  appName: "OpenCebola",
  // O apps/web já compila com output: "export". O app consome exatamente o mesmo artefato
  // que o site publica — não existe segunda interface para manter em paralelo.
  webDir: "../web/out",
  android: {
    allowMixedContent: false
  },
  server: {
    // https://localhost é a origem que apps/api/src/cors-policy.ts libera, sem credenciais.
    // Trocar isto quebra o app no primeiro POST, no preflight, antes de qualquer rota.
    androidScheme: "https",
    // O export estático do Next gera uma pasta por rota (`titulo/index.html`, por exemplo).
    // O fallback SPA padrão do Capacitor devolveria o index da home para todas elas.
    // MainActivity resolve cada pasta para o seu próprio index.html.
    html5mode: false
  }
};

export default config;
