# Instalar nos seus dispositivos

O repositório contém código para várias plataformas. **Não há binários publicados nesta prévia e a integração independente ainda exige testes em aparelhos.** Não use links de download de outra instalação.

| Plataforma | O que existe nesta base | Limite desta prévia |
| --- | --- | --- |
| Web/PWA | Interface, API e integração Stremio | Testar sua conta, addons e codecs no navegador |
| Android / Android TV | Projeto Capacitor, libVLC e adaptador de motor local | APK de desenvolvimento; validação em hardware e assinatura de release próprias |
| Linux | Tauri, GStreamer/mpv e serviço de streaming | Exige bibliotecas/toolchain nativas; compilação e execução por distribuição |
| Windows | Tauri e configuração de instalador NSIS | Bibliotecas nativas precisam ser preparadas; não há instalador pronto |
| iOS | Projeto Capacitor/Xcode, Nuvio e MPVKit | macOS/Xcode, assinatura e testes físicos pendentes |
| Samsung Tizen | Casca web, ponte AVPlay e serviço local | SDK/certificado e validação na TV; compatibilidade varia por modelo |
| Roku | Casca SceneGraph, biblioteca remota, pareamento, perfis e início | Base de navegação; não anunciar reprodução completa como homologada |
| LG webOS / macOS nativo | Não há aplicativo OpenCebola dedicado completo | Não suportados como pacote nesta prévia; navegador é opção separada |

## Antes de compilar para outro aparelho

Inicie sua API e sirva sua interface. Configure no `.env` da **sua cópia** os endereços acessíveis pelo aparelho, seguindo `.env.native.example`:

```dotenv
NEXT_PUBLIC_CEBOLA_API_URL=https://instance.example.invalid
NEXT_PUBLIC_OPENCEBOLA_WEB_URL=https://instance.example.invalid
CEBOLA_WEB_ORIGIN=https://instance.example.invalid
```

Substitua os exemplos por seus endereços reais. O assistente rejeita `.invalid`, credenciais em URLs e `localhost` para TVs/celulares. Esses aparelhos precisam alcançar o computador/servidor; um PC desligado não pode fornecer a API ou a biblioteca Roku. HTTPS deve usar um certificado aceito pelo aparelho.

```sh
npm run native:configure
```

O comando gera apenas configurações públicas: `apps/tizen/www/instance.js` e `apps/roku/telas/components/InstanceConfig.brs`. São arquivos locais ignorados pelo Git. Senhas Stremio, service-role e tokens debrid não entram nos pacotes.

As URLs do Android/iOS/desktop vêm do build web. Sempre recompile ao mudar de instância. Canais herdados de atualização automática estão desativados; atualize pela sua própria compilação e assinatura.

## Android, Android TV, projetores e TV boxes

Instale Android Studio/SDK, JDK 21 e as plataformas declaradas nos arquivos Gradle. Depois:

```sh
npm run package:android
```

Os APKs de desenvolvimento ficam em `apps/app/android/app/build/outputs/apk/debug/`. O projeto gera variantes ARM64 e ARMv7: escolha pela arquitetura do aparelho, não apenas por ser celular ou TV. Instale o arquivo pelo gerenciador do aparelho, autorizando a origem de instalação escolhida, ou use `adb install` com o caminho exato do APK gerado.

Esse comando gera a variante sem o AAR de torrent local. Para compilar o motor, o script exige NDK `29.0.14206865` e CMake `4.1.2` do SDK:

```sh
bash scripts/android-build-streaming.sh
npm run sync --workspace=@cebola/app
cd apps/app/android
./gradlew assembleDebug -PcebolaLocalStreaming=true
```

No Windows, use `gradlew.bat`; os scripts Bash exigem ambiente compatível. Para release, use suas próprias chaves e as variáveis `CEBOLA_ANDROID_KEYSTORE_PATH`, `CEBOLA_ANDROID_STORE_PASSWORD`, `CEBOLA_ANDROID_KEY_ALIAS` e `CEBOLA_ANDROID_KEY_PASSWORD`. Nunca compartilhe o keystore ou senhas. Não distribuímos chaves de assinatura.

O ID Android independente é `org.opencebola.app`, para não substituir o app de outra distribuição.

## Linux

É necessário Rust/Cargo, compilador C/C++, CMake, Ninja e as bibliotecas de desenvolvimento exigidas pelo Tauri, GTK/WebKitGTK, GStreamer e mpv. As dependências exatas variam por distribuição; veja `apps/pc/src-tauri/Cargo.toml` e `third_party/nuvio-engine/cmake/Dependencies.cmake`.

```sh
npm run package:linux
./dist/linux/abrir.sh
```

O comando compila o motor local e o aplicativo; pode baixar dependências nativas. Os arquivos ficam em `dist/linux/`. Isso é um build local, não um pacote universal nem uma garantia de funcionamento em qualquer Linux.

## Windows

Use Windows com Rust/MSVC, ferramentas C++ do Visual Studio, WebView2, CMake/Ninja e as bibliotecas do player. A configuração `apps/pc/src-tauri/tauri.windows.conf.json` declara os diretórios de staging necessários para GStreamer, mpv e o serviço de streaming.

```sh
npm run package:windows
```

O comando chama o build Tauri/NSIS, mas **não baixa nem prepara automaticamente todas as DLLs e o serviço nativo**. Sem esses pré-requisitos, não gera um instalador funcional. O instalador, quando compilado, fica em `apps/pc/src-tauri/target/release/bundle/nsis/`.

Essa cadeia de empacotamento independente ainda precisa ser validada no Windows. Não há certificado de assinatura de código incluído.

## iPhone/iPad

Use macOS com Xcode e as ferramentas Apple. Configure sua instância e execute:

```sh
npm run package:ios
```

O comando exporta a interface, sincroniza o Capacitor e configura a ponte nativa. Abra `apps/app/ios/App/App.xcodeproj`, selecione sua equipe de assinatura e seu identificador, resolva os pacotes Swift e compile no aparelho. O script não gera nem publica automaticamente uma versão App Store/TestFlight.

MPVKit e o motor Apple têm dependências externas; confira as licenças e os requisitos de versão antes de distribuir. Reprodução, permissões e ciclo de vida ainda precisam de teste físico nesta distribuição.

## Samsung Tizen

Instale o SDK Tizen com extensão de TV e configure seu próprio certificado/perfil. Ative o Developer Mode da TV e conecte o SDK conforme a [documentação Samsung](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html).

No `.env`, configure `CEBOLA_TIZEN_SDK_ROOT` e `CEBOLA_TIZEN_PROFILE`, além das URLs da instância. O package/application ID de `apps/tizen/config.xml` precisa ser compatível com seu certificado; ele não constitui uma identidade pública registrada por este projeto.

```sh
npm run native:configure
npm run doctor --workspace=@cebola/tizen
npm run package:tizen
```

O pacote esperado é `apps/tizen/dist/cebola-tizen.wgt`. Instale usando o SDK conectado à sua TV. O baseline do manifesto exige Tizen 9+; isso não garante que todos os modelos tenham os mesmos codecs ou permissões.

A casca carrega a interface da sua instância e utiliza a ponte nativa. Mantenha a interface servida na origem configurada. Não inclua certificados, DUIDs, IPs pessoais ou senhas nos commits.

## Roku

A instalação usa o **Development Application Installer (sideload)**, conforme a [documentação Roku](https://developer.roku.com/dev/docs/development-setup). Não é uma publicação na loja. Ativar o modo de desenvolvedor e instalar um pacote pode substituir o aplicativo de desenvolvimento já instalado no aparelho.

No `.env` da sua cópia, informe as URLs da API/interface e:

```dotenv
CEBOLA_ROKU_TELAS_URL=https://instance.example.invalid/downloads/cebola-roku-telas.zip
CEBOLA_ROKU_BUILD_VERSION=1
```

Troque o host e aumente a versão a cada novo pacote. Com Bash, `zip` e `unzip` disponíveis:

```sh
npm run package:roku
```

Serão produzidos:

- `apps/roku/dist/cebola-roku.zip`: casca a instalar no Roku.
- `apps/roku/dist/cebola-roku-telas.zip`: biblioteca a servir na URL configurada.

Publique a biblioteca no seu próprio servidor web (que pode estar na sua rede). A recuperação da casca também procura `cebola-roku-telas-anterior.zip`; mantenha a última versão funcional com esse nome quando atualizar. Não envie esses ZIPs ao Git como código-fonte.

No navegador do seu computador/celular, abra o instalador no endereço de rede exibido pelo Roku, use o usuário `rokudev` e a senha de desenvolvedor definida por você. Envie **a casca**, não o ZIP de telas. A senha do instalador não é enviada ao OpenCebola.

Abra o app e aprove o código em **Configurações → Aparelhos** da sua própria instância. O Roku precisa alcançar tanto a API quanto a biblioteca de telas.

**Limite:** a base atual possui pareamento, perfis e navegação inicial. Compilar/instalar essa casca não comprova um player Roku completo; fontes, codecs, legendas e reprodução precisam de implementação/validação específica. A conexão Stremio ou Real-Debrid não elimina esse trabalho.
