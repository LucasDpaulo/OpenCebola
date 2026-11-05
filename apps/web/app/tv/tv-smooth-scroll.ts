// Rolagem animada da navegação por controle. O `scroll-behavior: smooth` nativo não servia: cada
// tecla começava uma animação nova que interrompia a anterior no meio (a fileira parava em
// lugares diferentes), então a TV rolava em `instant` — certo, mas duro. Aqui cada rolador
// persegue o ALVO mais recente: uma tecla nova só troca o destino, o movimento continua de onde
// está, e o ponto final é exatamente o mesmo do `instant`.

/** Constante de tempo da aproximação: ~95% do caminho em ~3×, ou seja ~330 ms (com 65 ms a
 *  fileira chegava em ~200 ms e o Lucas achou rápido demais na TV). */
const TAU_MS = 110;

/**
 * Teto do tempo que um quadro pode avançar. A TV às vezes congela 0,2–0,4 s no meio da rolagem
 * (pintando e decodificando a fileira nova na CPU); contando o tempo real, o quadro seguinte já
 * caía no fim — a tela "pulava" em vez de descer. Com o teto, depois do engasgo o movimento
 * continua de onde parou.
 */
const MAX_STEP_MS = 34;

/**
 * Um passo da aproximação exponencial (independe da taxa de quadros). Encosta no alvo quando
 * falta menos de meio pixel, para a animação terminar num número exato.
 */
export function approach(position: number, target: number, elapsedMs: number): number {
  const next = position + (target - position) * (1 - Math.exp(-Math.max(0, elapsedMs) / TAU_MS));
  return Math.abs(target - next) < 0.5 ? target : next;
}

type Axis = "x" | "y";
type Scroller = Element | Window;

interface Motion {
  position: number;
  target: number;
}

const motions = new Map<Scroller, Partial<Record<Axis, Motion>>>();
let lastFrame: number | null = null;

function element(scroller: Scroller): Element {
  return scroller === window ? (document.scrollingElement ?? document.documentElement) : (scroller as Element);
}

function current(scroller: Scroller, axis: Axis): number {
  const el = element(scroller);
  return axis === "x" ? el.scrollLeft : el.scrollTop;
}

function limit(scroller: Scroller, axis: Axis): number {
  const el = element(scroller);
  return Math.max(0, axis === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight);
}

// `instant` explícito: o `html` da TV tem `scroll-behavior: smooth`, que transformaria cada quadro
// numa animação nativa própria.
function write(scroller: Scroller, axis: Axis, value: number): void {
  scroller.scrollTo(axis === "x" ? { left: value, behavior: "instant" } : { top: value, behavior: "instant" });
}

function frame(now: number): void {
  const elapsed = Math.min(lastFrame === null ? 16 : now - lastFrame, MAX_STEP_MS);
  lastFrame = now;
  for (const [scroller, axes] of motions) {
    for (const axis of ["x", "y"] as const) {
      const motion = axes[axis];
      if (!motion) continue;
      motion.position = approach(motion.position, motion.target, elapsed);
      write(scroller, axis, motion.position);
      if (motion.position === motion.target) delete axes[axis];
    }
    if (!axes.x && !axes.y) motions.delete(scroller);
  }
  if (motions.size > 0) {
    requestAnimationFrame(frame);
  } else {
    lastFrame = null;
  }
}

/** Rola `scroller` até `target` no eixo dado; `animate: false` mantém o salto seco de antes. */
export function scrollAxisTo(scroller: Scroller, axis: Axis, target: number, animate: boolean): void {
  const clamped = Math.min(Math.max(0, target), limit(scroller, axis));
  if (!animate) {
    const running = motions.get(scroller);
    if (running) delete running[axis];
    write(scroller, axis, clamped);
    return;
  }
  const axes = motions.get(scroller) ?? {};
  const motion = axes[axis];
  if (motion) {
    motion.target = clamped;
    return;
  }
  const position = current(scroller, axis);
  if (Math.abs(clamped - position) < 1) return;
  axes[axis] = { position, target: clamped };
  const idle = motions.size === 0;
  motions.set(scroller, axes);
  if (idle) requestAnimationFrame(frame);
}
