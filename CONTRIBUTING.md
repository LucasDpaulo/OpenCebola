# Contribuir

Faça um fork, crie uma branch e execute os comandos do README. Descreva o problema e o comportamento esperado; adicione testes quando a alteração mudar contratos, autenticação, rede ou reprodução.

Antes do pull request:

```sh
npm run test:tooling
npm run check:public
npm run typecheck
npm test
```

Use fixtures sintéticas e mídia que você tem autorização para usar. Não anexe contas, tokens, URLs privadas de addons, bancos, históricos pessoais ou logs sem revisão. Relate falhas por plataforma, versão e código de erro sanitizado.

Para interfaces, preserve acessibilidade e navegação por controle remoto. Para aplicativos nativos, informe se validou apenas o código, a compilação ou um aparelho real. Contribuições mantêm a licença do projeto; preserve as licenças dos componentes de terceiros.
