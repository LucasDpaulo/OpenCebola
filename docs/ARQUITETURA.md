# Organização do projeto

| Diretório | Responsabilidade |
| --- | --- |
| `apps/web` | Interface Next/React exportada como arquivos estáticos |
| `apps/api` | Autenticação da instância, perfis, progresso e gateway Stremio |
| `packages/contracts` | Contratos e validações compartilhados |
| `apps/app` | Android/iOS e pontes Capacitor |
| `apps/pc` | Desktop Tauri, player e serviço local |
| `apps/roku` | Casca e biblioteca de telas SceneGraph |
| `apps/tizen` | Casca Samsung, AVPlay e serviço local |
| `infra/supabase/migrations` | Schema e funções, sem dados de usuários |
| `scripts` | Configuração, build e verificação pública |
| `third_party` | Componentes necessários, preservando licenças |
| `docs` | Uso, integração e limites das plataformas |

Os nomes internos `@cebola/*` e `CEBOLA_*` foram mantidos para reduzir mudanças nos contratos e componentes. Eles não apontam para um serviço dos mantenedores.

## Fronteiras

O navegador recebe apenas URLs públicas e os dados autorizados da sessão. A API recebe segredos do `.env` privado. A chave service-role não vai para o cliente. Conexões Stremio são criptografadas pelo cofre; a chave do cofre deve acompanhar os backups privados do operador.

Cada casa tem sua conexão Stremio; perfis mantêm biblioteca e progresso próprios. O Real-Debrid opcional do backend é configurado por instalação, não por perfil. Não houve mudança para um modelo SaaS multi-inquilino neste recorte.

O motor e o player são separados do protocolo de addons. A web depende dos recursos do navegador; adaptadores nativos estão em `apps/web/app/streaming`, `apps/app`, `apps/pc` e `apps/tizen`. A casca Roku tem uma implementação própria e cobertura funcional diferente.

## Integrações externas

A base pode consultar Stremio/addons, metadados TMDB, trailers YouTube, provedores de legendas, serviços de marcação de abertura/encerramento e fontes editoriais/livros. Nem toda chamada externa exige token. Quem quiser uma distribuição mais restrita deve revisar esses módulos e seus termos; "local" significa executar sua instância no seu computador, não operar sem internet.

As fontes editoriais não são uma licença de acesso aos vídeos. Desabilitar um serviço de metadados pode reduzir a interface editorial sem impedir a consulta dos addons compatíveis.

## Histórico independente

Esta distribuição foi preparada por seleção de arquivos de código e licenças. Não inclui histórico Git anterior, ambientes privados, banco exportado, certificados, workflows de produção, backups ou registros operacionais. As alterações futuras devem ser versionadas no próprio repositório OpenCebola.
