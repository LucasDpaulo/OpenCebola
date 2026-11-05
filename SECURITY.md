# Segurança

Credenciais e dados pertencem à instalação do operador. Use `.env` privado, mantenha chaves de criptografia e backups em armazenamento privado e configure HTTPS ao acessar de outro aparelho.

Não publique segredos em issues, pull requests, screenshots ou logs. Se detectar um segredo exposto, revogue-o no serviço de origem e substitua-o na sua instância; apagar o arquivo do último commit não remove cópias do histórico.

Quando este projeto tiver um repositório público com canal privado de reporte habilitado, use esse canal para vulnerabilidades sensíveis. Enquanto não existir, não abra um relato público contendo dados exploráveis ou credenciais. Um aviso público pode descrever o problema de forma sanitizada.

O comando `npm run check:public` é uma camada de detecção, não uma garantia de ausência de segredos ou vulnerabilidades.
