# Validação desta prévia

Validação da extração inicial do OpenCebola, em 5 de novembro de 2026.

| Verificação | Resultado |
| --- | --- |
| Instalação `npm ci` em cópia limpa fora do projeto de origem | Passou |
| Typecheck da API e da interface | Passou |
| Build de produção da API e exportação estática web | Passou; 16 páginas geradas |
| Testes da API | 394 passaram |
| Testes da interface | 646 passaram |
| Testes Roku | 14 passaram |
| Testes Tizen | 70 passaram |
| Testes dos comandos/configuração/auditoria | 5 passaram |
| Auditoria de padrões de segredos e arquivos privados | Passou para os arquivos preparados |
| Comparação privada com credenciais da instalação de origem | Nenhuma coincidência encontrada; valores não incluídos no relatório |

Total: **1.129 testes passando** nas suítes acima. Testes de empacotamento com SDK simulado não equivalem a uma compilação assinada oficial ou teste físico.

## O que ainda precisa de validação real

- Iniciar a pilha Docker/Supabase local e concluir o primeiro acesso. O assistente foi testado com serviços simulados; a pilha real não foi iniciada nesta rodada por falta de espaço disponível no disco de validação.
- Conectar uma conta Stremio real na nova instalação e testar seus addons. Nenhuma conta ou credencial real foi usada na validação.
- Validar reprodução, codecs, legendas, pareamento e retomada nos aparelhos de cada plataforma.
- Completar e validar o fluxo de reprodução Roku; navegação inicial não é player homologado.
- Compilar/assinar os binários nativos com os SDKs e identidades da distribuição independente.
- Revisar a composição e as obrigações de licença dos binários finais antes de distribuí-los.

## Publicação

A validação acima foi realizada antes da primeira publicação do código em [LucasDpaulo/OpenCebola](https://github.com/LucasDpaulo/OpenCebola). Não houve publicação de site nem disponibilização de instaladores. A auditoria automática não substitui a revisão humana do conteúdo e dos artefatos.
