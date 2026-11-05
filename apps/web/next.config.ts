import type { NextConfig } from "next";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Marcador de versão do build. A TV (que roda o app remoto e é suspensa em vez de fechada)
// busca /version.txt de tempos em tempos e ao voltar do repouso; quando muda, o app se recarrega
// sozinho — é assim que um deploy chega à TV sem reinstalar o pacote nem depender de cache.
const buildId = process.env.CEBOLA_BUILD_ID ?? String(Date.now());
try {
  const publicDir = join(process.cwd(), "public");
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "version.txt"), buildId);
} catch {
  // Em ambientes só-leitura o app apenas não se auto-recarrega; nunca deixa o build falhar.
}

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  env: { NEXT_PUBLIC_BUILD_ID: buildId }
};

export default nextConfig;
