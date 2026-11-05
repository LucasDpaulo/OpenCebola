# Conta Stremio, addons e reprodução

## Conectar e testar sua conta

1. Execute a sua instância e entre com o usuário criado nela.
2. Crie/selecione um perfil e abra **Configurar Stremio** no menu.
3. Informe suas credenciais Stremio no formulário da sua própria instância. Não as envie para mantenedores, issues ou exemplos de configuração.
4. Confirme a conexão e a contagem de addons aceitos. A tela também pode indicar addons rejeitados por formato ou transporte incompatível.
5. Quando alterar addons na sua conta Stremio, use a sincronização na interface. O serviço também atualiza a coleção após o prazo de cache.
6. Abra um catálogo ou faça uma busca; escolha um filme ou um episódio e consulte as fontes disponíveis.

A implementação atual usa login e consulta da coleção pela API Stremio. Não é um fluxo OAuth nem uma página de login hospedada pelo Stremio. A senha passa pela API da SUA instância para autenticar; o serviço guarda o token e os descritores de addons criptografados no banco. Por isso, conecte sua conta somente a uma instância que você administra/confia e use HTTPS ao acessá-la fora do computador local.

Uma conexão Stremio é compartilhada pelos perfis da mesma casa nesta base. Histórico, biblioteca e progresso são mantidos no banco OpenCebola por perfil; **não há promessa de sincronização bidirecional do histórico/biblioteca com o Stremio**.

## Como os addons são selecionados

- A sincronização consulta os addons instalados na conta, sem instalar um pacote de addons dos mantenedores.
- O manifesto informa recursos, tipos de mídia e catálogos. A integração valida o formato e aceita transportes HTTPS sem credenciais HTTP embutidas.
- Para catálogo e busca, são consultados os catálogos compatíveis. Para detalhes, fontes e legendas, entram os recursos correspondentes ao tipo e identificador da mídia.
- Fontes são identificadas pelo addon de origem. A disponibilidade depende da resposta do addon, das suas configurações e de eventuais serviços externos.
- Se um addon exige configuração própria, faça-a pelo fluxo indicado pelo próprio fornecedor e sincronize novamente. Não publique URLs configuradas: elas podem conter tokens no caminho ou nos parâmetros.

Esta prévia importa a coleção existente. Não inclui um gerenciador completo para instalar, remover ou reorganizar remotamente os addons da sua conta. Compatibilidade não é universal; addons rejeitados não devem ser contornados desligando as proteções de rede.

## Títulos e fontes

Um item de catálogo leva ao identificador da mídia. Filmes usam o identificador do vídeo; séries também dependem da temporada/episódio. Ao pedir reprodução, o gateway consulta recursos `stream` compatíveis e a interface apresenta as opções resultantes. O caminho editorial TMDB, quando configurado, precisa associar o título a um identificador aceito pelos addons.

Use conteúdo próprio, autorizado ou de domínio público para validar o fluxo. Um roteiro de teste é: conectar → sincronizar → abrir catálogo → buscar → escolher título/episódio → escolher fonte → reproduzir → pausar e retomar → trocar de perfil e confirmar o isolamento do progresso.

Não registre tokens, senhas, URLs de fontes ou histórico pessoal nos relatórios de teste. Uma falha pode ser descrita por plataforma, versão, recurso solicitado e código de erro sanitizado.

## Addon não é player

O addon entrega dados e fontes. O player decodifica o vídeo, áudio e legendas; um motor de transporte pode ser necessário para obter os bytes.

- **Link HTTP(S):** pode tocar diretamente, se formato, codec, autenticação, CORS e aparelho permitirem.
- **Torrent:** exige um motor local disponível naquela compilação ou um serviço compatível que resolva uma fonte reproduzível.
- **Link externo:** pode exigir reprodução em outro aplicativo; não equivale a uma fonte embutida compatível.

A disponibilidade do motor local varia. Consulte [Plataformas](PLATAFORMAS.md); especialmente Roku não recebe automaticamente um motor torrent por conectar a conta Stremio.

## Real-Debrid opcional

Alguns addons podem usar a conta Real-Debrid configurada pelo usuário para retornar links compatíveis. Separadamente, o backend OpenCebola tem um adaptador opcional habilitado por `CEBOLA_REAL_DEBRID_TOKEN` no `.env` privado. Esse token é da instalação e não representa suporte multiusuário a contas debrid diferentes. Ao compartilhar uma instância, considere esse alcance antes de habilitá-lo.

O serviço pode ajudar na obtenção de links para fontes compatíveis, mas não executa todos os addons, não garante codecs e não concede licença de acesso aos materiais. **Assinar Real-Debrid não concede direitos sobre os conteúdos.** Não distribuímos tokens, contas, listas de fontes ou instruções para contornar controle de acesso.

Referências: [API Real-Debrid](https://api.real-debrid.com/) e [termos de uso](https://real-debrid.com/terms?lang=en).

## Referências de integração

- [Protocolo oficial de addons Stremio](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)
- [Cliente da API Stremio e sincronização de addons](https://github.com/Stremio/stremio-api-client)
- Implementação local: `apps/api/src/stremio/api-client.ts`, `service.ts`, `gateway.ts` e `routes.ts`.

OpenCebola é independente; mudanças nas APIs externas podem exigir manutenção.
