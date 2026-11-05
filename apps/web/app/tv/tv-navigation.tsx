"use client";

import { useEffect } from "react";
import { getNextFocus } from "@bbc/tv-lrud-spatial";
import { isAndroidTvRuntime, isTvRuntime } from "../api-client";
import { isTvPreviewBuild } from "./tv-layout";
import { dentroDaCasca, sairDaCasca } from "./tizen-casca";
import { findAdjacentTvZoneIndex, type TvZoneDirection } from "./tv-zone-navigation";
import { scrollAxisTo } from "./tv-smooth-scroll";

// A escolha do próximo foco é da lib da BBC (LRUD): geometria de bordas + containers
// (`nav`, `section`, `.lrud-container`) com memória do último filho focado. Ela cuida bem de
// ←/→ dentro de uma fileira (candidatos do mesmo tamanho, lado a lado). Mas ↑/↓ na home não dava
// pra confiar nela: os cards crescem ao ganhar foco e as fileiras têm alturas bem diferentes,
// então "candidato mais próximo por distância de borda" acabava pulando pro lugar errado (ver
// `tv-zone-navigation.ts`). Por isso ↑/↓ viram navegação por ZONAS quando a página marca
// `data-tv-zone` (home, hoje); páginas sem zona (título, busca, perfis, player…) seguem só com o
// LRUD, como sempre.
// `:not([tabindex='-1'])` precisa valer pra TODAS as alternativas, não só pra `[tabindex]`: um
// `<a href>`/`<button>` com `tabindex="-1"` (usado pra tirar elemento decorativo do caminho do
// controle, ex.: o link do pôster do banner) ainda casava `a[href]`/`button:not([disabled])`
// sozinhos — o `first`/`firstVisibleFocusable` daqui (usados no foco inicial e nas zonas)
// achavam esses elementos "invisíveis" como se fossem focáveis de verdade (o LRUD da BBC já
// filtra isso certo por conta própria, por isso só ←/→ nunca pegavam esse bug).
const SELECTOR = "a[href]:not([tabindex='-1']),button:not([disabled]):not([tabindex='-1']),input:not([disabled]):not([tabindex='-1']),select:not([disabled]):not([tabindex='-1']),[tabindex]:not([tabindex='-1'])";
const ZONE_SELECTOR = "[data-tv-zone]";
const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

function visible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function firstVisibleFocusable(scope: ParentNode): HTMLElement | undefined {
  return [...scope.querySelectorAll<HTMLElement>(SELECTOR)].find(visible);
}

// O elemento que recebe foco de verdade quase nunca é "o card inteiro": no Top 10, por exemplo,
// é um link dentro do pôster, à direita do número gigante; num card comum, é o link que só cobre
// a mídia (a ficha fica embaixo, fora dele). Rolar até ELE sozinho corta o resto do card (o
// número do Top 10 ficava pra fora, "cortado" à esquerda). Rolar até o CARD inteiro resolve —
// mas só dentro de uma fileira da HOME (`[data-tv-zone]`): a grade de resultados da busca reusa
// os mesmos componentes de card, e ali eles não crescem nem têm ficha (ver styles.css), então
// não faz sentido (nem sobra o que) ancorar como se fossem os desta fileira.
const CARD_SELECTOR = ".editorial-card, .progress-card, .top-ten-card";

/**
 * Depois do `focus()`, decide como a página rola — um `next.scrollIntoView` único centralizava
 * QUALQUER coisa, o que escondia o topo (menu + banner) sempre que o foco estava perto do
 * rodapé do banner. Este helper separa em três casos:
 *
 * 1. Banner ou menu: os dois formam uma unidade (referência) — rola pro TOPO da página, nunca
 *    centraliza um botão específico.
 * 2. Card de fileira: rola o CARD inteiro (não o link/mídia focada) até o início da fileira no
 *    eixo horizontal; no eixo vertical, CENTRALIZA a SEÇÃO (título + card focado + ficha) numa
 *    conta só, ou encosta o título no topo se ela não couber na tela.
 * 3. Qualquer outra coisa (busca, configurações…): mantém o comportamento simples de antes.
 */
// O projetor (`data-tv-lite`, WebView fraca) continua no salto seco; nas demais TVs a rolagem anda.
function animateScroll(): boolean {
  return document.documentElement.dataset.tvLite !== "on";
}

/** Primeiro ancestral que rola na horizontal (a faixa da fileira). */
function horizontalScroller(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = window.getComputedStyle(parent).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && parent.scrollWidth > parent.clientWidth) return parent;
  }
  return null;
}

/**
 * O mesmo ponto de `scrollIntoView({ inline: "start" })` (borda do card na borda da faixa,
 * respeitando `scroll-padding`/`scroll-margin`), mas calculado: o retângulo é medido na posição
 * atual, então o alvo dá o mesmo valor mesmo com uma animação ainda andando.
 */
function scrollCardToStart(card: HTMLElement): void {
  const scroller = horizontalScroller(card);
  if (!scroller) return;
  const padding = parseFloat(window.getComputedStyle(scroller).scrollPaddingLeft) || 0;
  const margin = parseFloat(window.getComputedStyle(card).scrollMarginLeft) || 0;
  const offset = card.getBoundingClientRect().left - scroller.getBoundingClientRect().left - scroller.clientLeft;
  scrollAxisTo(scroller, "x", scroller.scrollLeft + offset - padding - margin, animateScroll());
}

// O `loading="lazy"` só baixa o que já entrou na faixa visível da fileira: ao chegar no card
// seguinte, pôster e arte começavam do zero (quadro preto até carregar). Os próximos já vão
// sendo pedidos enquanto a pessoa ainda está no card atual.
const WARM_AHEAD = 3;

function warmNeighborCards(card: HTMLElement): void {
  const scroller = horizontalScroller(card);
  if (!scroller) return;
  const cards = Array.from(scroller.querySelectorAll<HTMLElement>(CARD_SELECTOR));
  const index = cards.indexOf(card);
  if (index < 0) return;
  for (const neighbor of cards.slice(Math.max(0, index - 1), index + WARM_AHEAD + 1)) {
    neighbor.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach((image) => { image.loading = "eager"; });
  }
}

/**
 * Rolagem VERTICAL da página. Aqui vale a rolagem nativa animada, e não a de
 * `tv-smooth-scroll.ts`: ao descer, a TV passa ~0,25 s pintando a fileira nova na CPU e a thread
 * principal fica presa — uma animação feita em JS (que precisa dela a cada quadro) congelava junto,
 * enquanto a nativa roda no compositor e continua descendo. O alvo é absoluto, então uma tecla nova
 * no meio só troca o destino. (A mesma troca na horizontal deixaria a fileira sem controle de
 * velocidade, e lá o JS não engasga.)
 */
function scrollPageTo(top: number): void {
  if (!animateScroll()) {
    scrollAxisTo(window, "y", top, false);
    return;
  }
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function scrollFocusIntoView(next: HTMLElement): void {
  // Página de tela única (título na TV, `data-tv-fixed`): a janela não rola; só a fileira ou o
  // painel onde o foco está se ajusta o mínimo necessário.
  if (next.closest("[data-tv-fixed]")) {
    next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    return;
  }
  if (next.closest(".hero, header.navbar")) {
    scrollPageTo(0);
    return;
  }
  const card = next.closest(ZONE_SELECTOR) ? next.closest<HTMLElement>(CARD_SELECTOR) : null;
  // Nada de `scrollIntoView` animado: o `html` tem `scroll-behavior: smooth`, e cada rolagem
  // nativa interrompia a anterior no meio (a fileira parava em lugares diferentes). Ver
  // `tv-smooth-scroll.ts`.
  if (card) {
    scrollCardToStart(card);
    warmNeighborCards(card);
  }
  const row = next.closest("section");
  if (row) {
    // Fileira (título + card focado + ficha) no MEIO da tela, numa conta só; se não couber
    // inteira, o título encosta no topo para nunca sumir.
    const rect = row.getBoundingClientRect();
    // A barra do topo fica fixa na TV: o "meio" é o da área visível abaixo dela.
    const barra = document.querySelector("header.navbar")?.getBoundingClientRect().height ?? 0;
    const area = window.innerHeight - barra;
    const offset = rect.height <= area ? (area - rect.height) / 2 : 0;
    scrollPageTo(window.scrollY + rect.top - barra - offset);
  }
  if (!row && !card) next.scrollIntoView({ block: "nearest", inline: "start", behavior: "auto" });
}

// A tela de reprodução tem teclas próprias (seta = avançar/voltar, cima/baixo = volume). Enquanto
// o player nativo está montado, a navegação por foco sai de cena para não competir com ele.
function playerOpen(): boolean {
  return document.querySelector("[data-player-nativo]") !== null;
}

export function TvNavigation() {
  useEffect(() => {
    if (!isTvRuntime() && !isTvPreviewBuild()) return;
    const androidTv = isAndroidTvRuntime();
    // Prévia = build de teste do PC (sem projetor/Tizen de verdade por trás). Serve só para o
    // Lucas conferir no AppImage, onde não dá pra digitar `?tv=1`.
    const preview = isTvPreviewBuild() && !isTvRuntime();
    // O layout é o mesmo; `data-tv-runtime` só liga a camada de ergonomia do controle remoto.
    document.documentElement.dataset.tvRuntime = preview ? "preview" : androidTv ? "androidtv" : "tizen";
    // Modo leve (corta backdrop-filter/blur/animações) só no projetor, que renderiza numa WebView
    // fraca. A Samsung aguenta animação de transform/opacidade (é o que deixa a navegação fluida);
    // lá o CSS corta só blur e filtros (`data-tv-runtime="tizen"`, styles.css).
    if (androidTv) document.documentElement.dataset.tvLite = "on";

    // Última posição focada dentro de cada zona — sem isto, voltar pra uma fileira com ↑/↓
    // sempre caía no primeiro card dela, perdendo o lugar onde a pessoa estava.
    const zoneMemory = new WeakMap<Element, HTMLElement>();
    const rememberFocus = (element: HTMLElement) => {
      const zone = element.closest(ZONE_SELECTOR);
      if (zone) zoneMemory.set(zone, element);
    };

    // Ao abrir, o foco começa na seção atual da barra ("Início"), não no primeiro item dela.
    const activeSection = document.querySelector<HTMLElement>("header.navbar .navbar-center a.active");
    const first = activeSection && visible(activeSection) ? activeSection : firstVisibleFocusable(document);
    if (!(document.activeElement instanceof HTMLElement) || document.activeElement === document.body) {
      first?.focus();
    }
    if (document.activeElement instanceof HTMLElement) rememberFocus(document.activeElement);

    /**
     * Move o foco pra zona anterior/seguinte. Devolve `true` quando a página TEM zonas (mesmo
     * que não exista zona válida naquela direção — aí só consome a tecla sem fazer nada, como
     * pedido); `false` quando a página não usa zona nenhuma, pra quem chamou cair no LRUD comum.
     */
    const moveZoneFocus = (direction: TvZoneDirection): boolean => {
      const zones = [...document.querySelectorAll<HTMLElement>(ZONE_SELECTOR)];
      if (zones.length === 0) return false;
      // Menu aberto dentro de uma zona (ex.: o do perfil, um `<details>` na barra): ↑/↓ andam
      // pelos itens dele pelo LRUD; pular de zona aqui tornava editar/trocar perfil e sair
      // inalcançáveis pelo controle.
      if (document.activeElement instanceof HTMLElement && document.activeElement.closest("details[open]")) return false;

      const currentZone = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>(ZONE_SELECTOR)
        : null;
      const currentIndex = currentZone ? zones.indexOf(currentZone) : (direction === "down" ? -1 : zones.length);
      const hasFocusable = zones.map((zone) => firstVisibleFocusable(zone) !== undefined);

      const nextIndex = findAdjacentTvZoneIndex(hasFocusable, currentIndex, direction);
      if (nextIndex === null) return true;

      const targetZone = zones[nextIndex]!;
      // Subindo pro menu, o foco cai sempre na seção atual ("Início", "Filmes"…) e dali anda
      // por ←/→ — não no último item lembrado (avatar, lupa), que parecia não ter subido.
      const activeSection = targetZone.matches("header.navbar")
        ? targetZone.querySelector<HTMLElement>(".navbar-center a.active")
        : null;
      const remembered = zoneMemory.get(targetZone) as HTMLElement | undefined;
      const target = activeSection && visible(activeSection)
        ? activeSection
        : (remembered && document.body.contains(remembered) && visible(remembered))
          ? remembered
          : firstVisibleFocusable(targetZone);
      if (target) {
        target.focus({ preventScroll: true });
        rememberFocus(target);
        scrollFocusIntoView(target);
      }
      return true;
    };

    const handler = (event: KeyboardEvent) => {
      if (ARROWS.has(event.key)) {
        if (playerOpen()) return;
        // Carrossel do banner pelo controle: só sobram 2 botões ("Assistir"/"Mais informações"),
        // então ← no da esquerda e → no da direita não têm mais pra onde ir dentro da zona — é
        // exatamente aí que viram "destaque anterior/próximo". Marcado por atributo
        // (`data-tv-edge-prev`/`-next` em home-experience.tsx, só na TV) porque este handler é
        // genérico e não conhece o estado do carrossel; quem sabe trocar o destaque é o React,
        // então só avisamos por evento (`window.dispatchEvent`) — o botão focado continua o
        // mesmo depois (mesma posição no DOM, só o conteúdo troca).
        if (document.activeElement instanceof HTMLElement) {
          if (event.key === "ArrowLeft" && document.activeElement.hasAttribute("data-tv-edge-prev")) {
            event.preventDefault();
            window.dispatchEvent(new CustomEvent("cebola:tv-hero-step", { detail: "prev" }));
            return;
          }
          if (event.key === "ArrowRight" && document.activeElement.hasAttribute("data-tv-edge-next")) {
            event.preventDefault();
            window.dispatchEvent(new CustomEvent("cebola:tv-hero-step", { detail: "next" }));
            return;
          }
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const handledByZones = moveZoneFocus(event.key === "ArrowUp" ? "up" : "down");
          if (handledByZones) {
            event.preventDefault();
            return;
          }
        }
        // ←/→ (e ↑/↓ em página sem zona) continuam pelo LRUD — geometria funciona bem dentro de
        // uma fileira, onde os candidatos são do mesmo tamanho e ficam lado a lado.
        //
        // getNextFocus aceita `event.key` ("ArrowLeft"…) ou keyCode (37–40); mandamos o keyCode,
        // que é o que o tipo publicado declara e o que a WebService de TV entrega de forma estável.
        // Conteúdo de `<details>` fechado (ex.: o menu do perfil) continua com caixa no layout
        // pro LRUD, que escolhia "Editar este perfil" escondido: o foco não entrava e a lupa
        // parecia travada. `.lrud-ignore` tira esse conteúdo da conta enquanto está fechado.
        document.querySelectorAll("details").forEach((details) => {
          for (const child of details.children) {
            if (child.tagName !== "SUMMARY") child.classList.toggle("lrud-ignore", !details.open);
          }
        });
        const next = getNextFocus(document.activeElement, event.keyCode);
        if (next) {
          // Quando a página tem zonas, nenhuma tecla pode tirar o foco da zona atual: o
          // fallback do LRUD (candidato mais próximo em QUALQUER lugar da tela, usado quando
          // não sobra nada dentro do container atual) podia levar ←/→ pra fora da fileira.
          const currentZone = document.activeElement instanceof HTMLElement
            ? document.activeElement.closest(ZONE_SELECTOR)
            : null;
          if (currentZone && next.closest(ZONE_SELECTOR) !== currentZone) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          next.focus({ preventScroll: true });
          rememberFocus(next);
          scrollFocusIntoView(next);
        }
        return;
      }
      if (event.key === "Enter" && !playerOpen() && document.activeElement instanceof HTMLElement) {
        event.preventDefault();
        document.activeElement.click();
        return;
      }
      if (["Escape", "Backspace", "BrowserBack"].includes(event.key) || event.keyCode === 10009) {
        event.preventDefault();
        const playerBack = document.querySelector<HTMLElement>("[data-player-nativo] [aria-label='Voltar']");
        if (playerBack) { playerBack.click(); return; }
        // Janela aberta (fontes, avaliação, menu do perfil): Voltar fecha ela, não sai da página.
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const layer = active?.closest<HTMLElement>('[role="dialog"], [aria-modal="true"], details[open]');
        if (layer) {
          const close = layer.querySelector<HTMLElement>('[aria-label^="Fechar"]');
          if (close) close.click();
          else if (layer instanceof HTMLDetailsElement) layer.open = false;
          else layer.closest("details")?.removeAttribute("open");
          return;
        }
        // Página com "voltar interno" (ex.: aba do título fora da Visão geral): volta pra ela.
        const backAction = document.querySelector<HTMLElement>("[data-tv-back-action]");
        if (backAction && visible(backAction)) {
          backAction.click();
          return;
        }
        // Na casca, `history.length` não serve: depois de ir e voltar ele continua > 1 mesmo na
        // primeira página, e o Voltar nunca fechava o app. A Navigation API (Chromium 120 da TV)
        // sabe se existe entrada anterior de verdade.
        const naCasca = dentroDaCasca();
        const canGoBack = (window as Window & { navigation?: { canGoBack?: boolean } }).navigation?.canGoBack;
        const podeVoltar = naCasca && typeof canGoBack === "boolean" ? canGoBack : window.history.length > 1;
        if (podeVoltar) window.history.back();
        else if (naCasca) {
          // Dentro da casca o objeto `tizen` não existe neste documento (só na janela da casca):
          // quem fecha o app é ela, a pedido nosso.
          sairDaCasca();
        } else {
          const runtime = window as Window & { tizen?: { application?: { getCurrentApplication(): { exit(): void } } } };
          runtime.tizen?.application?.getCurrentApplication().exit();
        }
      }
    };
    // Menu em `<details>` da barra (o do perfil): quando o foco sai dele, fecha — senão ficava
    // aberto por cima da home enquanto a pessoa já navegava pelas fileiras. Só os da barra: os
    // popups da página do título também usam `<details open>` (controlado pelo React) só como
    // trava de foco, e fechá-los por fora esconderia o popup.
    const closeLeftMenus = (event: FocusEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      document.querySelectorAll<HTMLDetailsElement>("header.navbar details[open]").forEach((details) => {
        if (!target || !details.contains(target)) details.open = false;
      });
    };
    document.addEventListener("focusin", closeLeftMenus);

    window.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("focusin", closeLeftMenus);
      window.removeEventListener("keydown", handler, true);
      delete document.documentElement.dataset.tvRuntime;
      delete document.documentElement.dataset.tvLite;
    };
  }, []);
  return null;
}
