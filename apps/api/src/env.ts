import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CEBOLA_API_HOST: z.string().default("127.0.0.1"),
  CEBOLA_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  CEBOLA_WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  CEBOLA_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(31_536_000)
    .default(2_592_000),
  // "true" liga trustProxy e o rate limit por IP real (API atrás do Cloudflare
  // + Caddy). O parse sempre devolve boolean (ausente = false); o `| undefined`
  // é só tipagem, para a propriedade seguir opcional nos Environment montados
  // à mão pelos testes.
  CEBOLA_TRUST_PROXY: z.enum(["true", "false"]).default("false")
    .transform((value): boolean | undefined => value === "true"),
  // "true" permite que gateway.streams devolva também URL de stream http:// (porta 80),
  // além de https:// (porta 443). Uso pretendido é local: em produção o navegador bloqueia
  // vídeo http:// dentro de página https:// (mixed content). O parse sempre devolve boolean
  // (ausente = false); o `| undefined` é só tipagem, para a propriedade seguir opcional nos
  // Environment montados à mão pelos testes.
  CEBOLA_ALLOW_INSECURE_STREAMS: z.enum(["true", "false"]).default("false")
    .transform((value): boolean | undefined => value === "true"),
  // Token privado da conta Real-Debrid. Só a API o lê; ele nunca pode ser NEXT_PUBLIC.
  CEBOLA_REAL_DEBRID_TOKEN: z.string().trim().min(20).max(256).optional(),
  // Chave pessoal SubDL usada somente pela API para buscar legendas externas.
  CEBOLA_SUBDL_API_KEY: z.string().trim().min(20).max(256).optional(),
  // Read Access Token (v4) do TMDB. Fica somente no backend; sem ele, as rotas
  // editoriais não são registradas e o catálogo Stremio continua funcionando.
  CEBOLA_TMDB_READ_TOKEN: z.string().trim().min(80).max(2_048).optional(),
  // Segredo simples que libera somente a tela administrativa do Stremio. Nunca é público.
  CEBOLA_STREMIO_ADMIN_PASSWORD: z.string().min(8).max(128).optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  CEBOLA_PIN_PEPPER_BASE64: z.string().min(43).max(256).refine((value) => {
    const normalized = value.replace(/=+$/, "");
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength >= 32 &&
      decoded.toString("base64").replace(/=+$/, "") === normalized;
  }, "O pepper deve ser Base64 canônico com pelo menos 32 bytes.").optional(),
  CEBOLA_STREMIO_VAULT_KEY_BASE64: z.string().min(44).max(44).refine((value) => {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength === 32 && decoded.toString("base64") === value;
  }, "A chave do cofre Stremio deve ter exatamente 32 bytes em Base64 canônico.").optional()
}).superRefine((environment, context) => {
  const configured = [
    environment.SUPABASE_URL,
    environment.SUPABASE_PUBLISHABLE_KEY,
    environment.SUPABASE_SERVICE_ROLE_KEY
  ].filter(Boolean).length;

  if (configured > 0 && configured < 3) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A configuração do Supabase deve conter URL, publishable key e service-role key."
    });
  }

  if (configured === 3 && !environment.CEBOLA_PIN_PEPPER_BASE64) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "CEBOLA_PIN_PEPPER_BASE64 é obrigatório quando o Supabase está configurado."
    });
  }

  if (configured === 3 && !environment.CEBOLA_STREMIO_VAULT_KEY_BASE64) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "CEBOLA_STREMIO_VAULT_KEY_BASE64 é obrigatória quando o Supabase está configurado."
    });
  }

  if (environment.NODE_ENV === "production" && configured !== 3) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A configuração completa do Supabase é obrigatória em produção."
    });
  }
});

export type Environment = z.infer<typeof environmentSchema>;

export interface SupabaseEnvironment {
  readonly url: string;
  readonly publishableKey: string;
  readonly serviceRoleKey: string;
  readonly pinPepper: Uint8Array;
  readonly stremioVaultKey: Uint8Array;
}

export function readEnvironment(input: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(input);
}

export function getSupabaseEnvironment(
  environment: Environment
): SupabaseEnvironment | null {
  if (
    !environment.SUPABASE_URL ||
    !environment.SUPABASE_PUBLISHABLE_KEY ||
    !environment.SUPABASE_SERVICE_ROLE_KEY ||
    !environment.CEBOLA_PIN_PEPPER_BASE64 ||
    !environment.CEBOLA_STREMIO_VAULT_KEY_BASE64
  ) {
    return null;
  }

  return {
    url: environment.SUPABASE_URL,
    publishableKey: environment.SUPABASE_PUBLISHABLE_KEY,
    serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY,
    pinPepper: Uint8Array.from(Buffer.from(environment.CEBOLA_PIN_PEPPER_BASE64, "base64")),
    stremioVaultKey: Uint8Array.from(
      Buffer.from(environment.CEBOLA_STREMIO_VAULT_KEY_BASE64, "base64")
    )
  };
}
