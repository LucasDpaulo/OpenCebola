# Componentes e recursos de terceiros

O código próprio do OpenCebola nesta distribuição usa GPL-3.0-or-later. Bibliotecas, fontes, imagens e componentes de terceiros mantêm os seus avisos e condições; a licença raiz não os substitui.

| Componente | Origem / avisos locais |
| --- | --- |
| Nuvio Engine | [Upstream](https://github.com/NuvioMedia/nuvio-engine), `third_party/nuvio-engine/LICENSE` e `THIRD_PARTY_NOTICES.md` |
| NuvioTVSmart: runtime Tizen | [Upstream](https://github.com/NuvioMedia/NuvioTVSmart), `third_party/nuvio-tvsmart/LICENSE`; apenas o runtime necessário foi incluído |
| MPVKit | [Upstream](https://github.com/NuvioMedia/MPVKit), `third_party/mpvkit/LICENSE` e documentação/licenças do pacote escolhido |
| libVLC / módulos do Android | `apps/app/LICENSES-TERCEIROS.md` e licenças do VideoLAN |
| Plugin de vídeo Tauri | `apps/pc/src-tauri/vendor/tauri-plugin-video/LICENSE-MIT` e `LICENSE-APACHE` |
| Fontes de legendas | `apps/web/public/fonts/subtitles/LICENSES.txt` |
| Dependências JavaScript/Rust/Swift/Gradle | Manifests e lockfiles dos respectivos componentes |

O script `scripts/tizen-build-engine.cjs` verifica o hash do runtime e extrai o núcleo utilizado. Alterar o hash sem revisar o componente não constitui validação.

Os componentes nativos podem incorporar dependências GPL/LGPL e variantes com obrigações diferentes. Antes de distribuir um binário, identifique exatamente os componentes compilados e forneça os avisos e fontes correspondentes exigidos. Esta lista não substitui uma revisão da composição final de cada artefato.

A captura de interface em `docs/images` foi fornecida para apresentação do projeto. Cartazes, fotos de elenco, marcas e outros materiais de terceiros exibidos nela não se tornam conteúdo livre por integrarem uma captura. Ela não é uma oferta de acesso às obras mostradas.

Stremio, Real-Debrid e os fabricantes de dispositivos não patrocinam nem endossam esta distribuição.
