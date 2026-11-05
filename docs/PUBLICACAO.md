# Antes de compartilhar ou publicar um fork

O repositório deve conter código, documentação, testes sintéticos e recursos visuais revisados. O banco e a configuração de execução pertencem a quem opera a instância.

## Verificação

```sh
npm run check:public
npm run test:tooling
npm run typecheck
npm test
```

A verificação pública procura arquivos privados, chaves privadas, tokens conhecidos, URLs com credenciais e caminhos pessoais. Ela não imprime o valor encontrado. Arquivos `.env` locais são ignorados, mas um `.env` rastreado no Git reprova a verificação.

Exceções ficam em `scripts/public-audit-exceptions.json`, com caminho exato, regra, SHA-256 e justificativa. Elas cobrem fixtures sintéticas de segurança e um componente upstream; mudar o arquivo invalida a exceção. Não crie uma exceção para acomodar um segredo real.

**O resultado automático não é uma certificação.** Faça também a revisão do diff, dos arquivos binários, das dependências e das licenças. Não publique:

- `.env`, credenciais Stremio, tokens debrid, service-role ou URLs de addons configuradas;
- bancos, sessões, dados de usuários, histórico pessoal, logs e backups;
- keystores, certificados privados, perfis de assinatura ou senhas;
- configurações de implantação de outra instalação ou arquivos gerados com segredos;
- screenshots com conta, e-mail, IP privado, histórico ou recomendações pessoais.

## Preparar o Git

Use um repositório **novo**, sem o histórico de uma instalação anterior. Revise os arquivos antes de adicionar e examine `git diff --cached --stat` e `git diff --cached` antes do primeiro commit. Execute novamente `npm run check:public` depois de adicionar arquivos, para verificar também os arquivos rastreados.

Defina o remoto do seu novo repositório apenas quando o conteúdo estiver revisado. Nenhum comando de configuração ou build desta base cria repositórios remotos, faz push ou publica automaticamente.

## Releases

Binários são uma entrega separada: compile para cada plataforma, teste em aparelho, confira permissões e URLs, assine com suas próprias chaves e disponibilize o código-fonte correspondente e os avisos exigidos pelas licenças.

Não anuncie downloads que ainda não existem. Descreva separadamente "código disponível", "pacote gerado" e "testado em aparelho". Não habilite um atualizador apontando para servidores de outra distribuição.
