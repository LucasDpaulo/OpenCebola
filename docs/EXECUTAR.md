# Executar o OpenCebola

## Local: sem contratar hospedagem

Instale Node.js 22.13+ e Docker. Dentro da pasta do projeto:

```sh
npm run setup
npm ci
npm run db:start
npm run user:add
npm run dev
```

A instalação usa **seu** PostgreSQL e autenticação Supabase locais. A CLI Supabase 2 é executada por `npx` no próprio projeto. Nenhum login na plataforma Supabase hospedada ou vínculo com projeto remoto é necessário. `supabase/` e `.env` são locais e ignorados pelo Git.

`db:start` verifica o Docker, inicializa a configuração local, copia as migrations de `infra/supabase/migrations`, inicia os serviços e aplica migrations pendentes. As credenciais retornadas pela CLI são capturadas e gravadas no `.env`, sem exibi-las. O comando recusa substituir uma configuração de banco remoto.

`user:add` pede e-mail e uma senha nova com pelo menos 12 caracteres, sem mostrar a senha na tela. Esse usuário existe apenas no banco da instalação configurada. Não use esse passo para cadastrar uma conta nos serviços dos mantenedores. A conta Stremio é outra conexão, configurada pela interface.

Abra **http://localhost:3000**. Use exatamente `localhost`, também no endereço da API; não misture com `127.0.0.1` ao navegar. A sessão web usa cookie HttpOnly/Secure; navegadores modernos tratam localhost como caso especial, mas acesso por IP da rede deve usar HTTPS. Se o seu navegador não aceitar a sessão local, use um proxy HTTPS local com certificado confiável.

Para encerrar a interface e a API: `Ctrl+C`. Para parar o banco sem apagar dados:

```sh
npm run db:stop
```

Não use `supabase db reset` em uma instalação com dados que deseja preservar. Esse comando não faz parte do assistente.

## Configuração

`npm run setup` cria chaves aleatórias para PINs e para criptografia das conexões Stremio. Ele nunca substitui um `.env` existente. Preserve essas chaves ao atualizar: trocar a chave do cofre impede ler as conexões já criptografadas.

| Variável | Uso |
| --- | --- |
| `CEBOLA_WEB_ORIGIN` | Origem exata permitida para a interface web |
| `NEXT_PUBLIC_CEBOLA_API_URL` | Endereço público da sua API, incorporado no build web |
| `NEXT_PUBLIC_OPENCEBOLA_WEB_URL` | Endereço da sua interface, usado em pareamento e trailers |
| `SUPABASE_URL` | Endpoint do seu Supabase local ou hospedado |
| `SUPABASE_PUBLISHABLE_KEY` | Chave usada pela API para autenticar usuários |
| `SUPABASE_SERVICE_ROLE_KEY` | Credencial administrativa: somente backend |
| `CEBOLA_PIN_PEPPER_BASE64` | Segredo de proteção dos PINs |
| `CEBOLA_STREMIO_VAULT_KEY_BASE64` | Chave de criptografia da conexão Stremio |
| `CEBOLA_TMDB_READ_TOKEN` | Opcional: catálogo editorial e metadados TMDB |
| `CEBOLA_REAL_DEBRID_TOKEN` | Opcional: conta Real-Debrid da instalação |
| `CEBOLA_SUBDL_API_KEY` | Opcional: serviço externo de legendas |

Variáveis opcionais ausentes devem continuar comentadas; não configure valores vazios ou placeholders como se fossem credenciais válidas. Não coloque segredos em variáveis `NEXT_PUBLIC_*`.

O assistente encaminha para o build web somente as duas URLs públicas permitidas. `.env` é usado pela API; não deve ser colocado na pasta estática, numa imagem pública ou enviado ao Git.

## Seu próprio servidor (opcional)

Você pode usar Supabase gerenciado na **sua conta**, ou sua própria instalação compatível. A base atual usa a API de autenticação, PostgREST e PostgreSQL do Supabase; apontar apenas para um PostgreSQL comum não é suficiente.

1. Prepare um projeto/banco vazio seu. Aplique os arquivos SQL de `infra/supabase/migrations` em ordem numérica, de `0001` a `0010`. São schemas e funções; não incluem usuários ou dados de outra instalação.
2. Execute `npm run setup` e configure o `.env` privado seguindo `.env.hosted.example`. Informe as três variáveis Supabase e mantenha as chaves locais geradas.
3. Configure as URLs HTTPS da sua API e interface. Execute `npm run user:add` contra esse banco para criar seu acesso.
4. Execute `npm ci` e `npm run build`. Sirva `apps/web/out` como arquivos estáticos. Ela já tem `index.html` por rota; não use `next start` para servir esse export.
5. Inicie a API, a partir da raiz: `node --env-file=.env apps/api/dist/server.js`. Configure o gerenciamento do processo no seu servidor.
6. Configure seu proxy HTTPS: encaminhe `/v1/` para `127.0.0.1:3001` e sirva os arquivos web na mesma origem, ou use as origens separadas declaradas no `.env`.

`CEBOLA_TRUST_PROXY=false` é o padrão. O código herdado de rate limit tem uma política específica para cabeçalhos de proxy; não habilite essa opção sem ajustar e testar a fronteira de confiança da sua implantação. Não exponha PostgREST administrativo, service-role ou Studio publicamente sem controle.

## Diagnóstico

```sh
npm run doctor
npm run test:tooling
npm run typecheck
npm test
```

- **Docker indisponível:** inicie o Docker e verifique a permissão do usuário para acessar o socket. Não use um banco remoto de outra pessoa para contornar isso.
- **Download de imagens/dependências falhou:** verifique internet e DNS; execute novamente. O primeiro início pode demorar vários minutos.
- **Portas já ocupadas:** outra pilha Supabase pode estar usando as portas locais padrão. Ajuste `supabase/config.toml` desta cópia; não pare serviços alheios automaticamente.
- **Somente health check responde:** faltam as configurações do banco; a API não inventa credenciais de fallback.
- **Catálogo editorial vazio:** TMDB é opcional. Conecte os addons Stremio e confira se oferecem catálogos compatíveis.
- **Nova URL não aparece no aplicativo:** URLs `NEXT_PUBLIC_*` são definidas no build. Recompile e reinstale.

Referência: [desenvolvimento local oficial do Supabase](https://supabase.com/docs/guides/local-development/cli/getting-started).
