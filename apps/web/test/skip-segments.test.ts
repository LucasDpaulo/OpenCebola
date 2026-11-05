import assert from "node:assert/strict";
import test from "node:test";
import {
  activeSkipSegment,
  canAdvanceOnEnded,
  isManualEndingVisit,
  playbackSkipBlocks,
  skipBlockLabel,
  mergeOpeningSegments,
  nextEpisodeCountdownStart,
  nextEpisodePromptStart,
  nextEpisodePromptState,
  segmentsFromChapters,
  shouldAutoSkipOpening,
  shouldResetNextEpisodeCancel,
  skipButtonVisible,
  type NativeChapter,
  type SkipBlock,
  type SkipSegment
} from "../app/player/pulos/skip-segments.js";

function segment(kind: SkipSegment["kind"], start: number, end: number, episodeLength: number | null = null): SkipSegment {
  return { kind, start, end, episodeLength };
}

test("intro e recap com intervalo de até 10s viram um só bloco 'opening'", () => {
  const blocks = mergeOpeningSegments([segment("recap", 0, 30), segment("intro", 35, 95)]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { kind: "opening", start: 0, end: 95, episodeLength: null });
});

test("a ordem intro-antes-de-recap também funde (o gap é o que importa, não quem vem primeiro)", () => {
  const blocks = mergeOpeningSegments([segment("intro", 0, 90), segment("recap", 95, 120)]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { kind: "opening", start: 0, end: 120, episodeLength: null });
});

test("cold open: intervalo maior que 10s mantém dois blocos separados", () => {
  const blocks = mergeOpeningSegments([segment("recap", 0, 30), segment("intro", 45, 105)]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { kind: "opening", start: 0, end: 30, episodeLength: null });
  assert.deepEqual(blocks[1], { kind: "opening", start: 45, end: 105, episodeLength: null });
});

test("cadeia transitiva: A perto de B perto de C funde tudo, mesmo que A e C estejam longe", () => {
  const blocks = mergeOpeningSegments([
    segment("recap", 0, 20),
    segment("intro", 28, 40),
    segment("intro", 48, 60)
  ]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { kind: "opening", start: 0, end: 60, episodeLength: null });
});

test("outro nunca funde com intro/recap, mesmo colado", () => {
  const blocks = mergeOpeningSegments([segment("intro", 0, 90), segment("outro", 92, 140)]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.find((b) => b.kind === "outro"), { kind: "outro", start: 92, end: 140, episodeLength: null });
  assert.deepEqual(blocks.find((b) => b.kind === "opening"), { kind: "opening", start: 0, end: 90, episodeLength: null });
});

test("episodeLength é herdado do primeiro segmento do grupo que o informa", () => {
  const blocks = mergeOpeningSegments([segment("recap", 0, 30, null), segment("intro", 35, 95, 1430)]);
  assert.equal(blocks[0]?.episodeLength, 1430);
});

test("sem segmentos, não há blocos", () => {
  assert.deepEqual(mergeOpeningSegments([]), []);
});

const OPENING: SkipBlock = { kind: "opening", start: 0, end: 90, episodeLength: null };
const OUTRO: SkipBlock = { kind: "outro", start: 1300, end: 1350, episodeLength: null };

test("activeSkipSegment acha o bloco que contém a posição", () => {
  assert.deepEqual(activeSkipSegment([OPENING, OUTRO], 30, 1400), OPENING);
  assert.deepEqual(activeSkipSegment([OPENING, OUTRO], 1320, 1400), OUTRO);
});

test("activeSkipSegment retorna null fora de qualquer bloco", () => {
  assert.equal(activeSkipSegment([OPENING, OUTRO], 500, 1400), null);
});

test("activeSkipSegment descarta TODOS os blocos quando episodeLength diverge >5% da duração real", () => {
  const withLength: SkipBlock = { ...OPENING, episodeLength: 1430 };
  // duração real bem menor (release com corte diferente): 1430 vs 1000 diverge bem mais que 5%.
  assert.equal(activeSkipSegment([withLength, OUTRO], 30, 1000), null);
});

test("activeSkipSegment mantém os blocos quando episodeLength está dentro de 5% da duração", () => {
  const withLength: SkipBlock = { ...OPENING, episodeLength: 1430 };
  assert.deepEqual(activeSkipSegment([withLength], 30, 1400), withLength);
});

test("activeSkipSegment não descarta quando episodeLength é null (fonte não informou)", () => {
  assert.deepEqual(activeSkipSegment([OPENING], 30, 1000), OPENING);
});

test("activeSkipSegment não descarta quando a duração ainda não é conhecida", () => {
  const withLength: SkipBlock = { ...OPENING, episodeLength: 1430 };
  assert.deepEqual(activeSkipSegment([withLength], 30, 0), withLength);
});

test("nextEpisodePromptStart usa o início do outro quando ele existe", () => {
  assert.equal(nextEpisodePromptStart([OPENING, OUTRO], 1400), 1300);
});

test("nextEpisodePromptStart sem outro: 45s antes do fim em episódio curto (anime)", () => {
  assert.equal(nextEpisodePromptStart([OPENING], 1200), 1155);
  // One Piece: 23:51 → cartão em 23:06, junto do "To Be Continued" (23:10).
  assert.equal(nextEpisodePromptStart([], 1431), 1386);
});

test("nextEpisodePromptStart sem outro: 60s antes do fim entre 30 e 40 min", () => {
  assert.equal(nextEpisodePromptStart([OPENING], 2100), 2040);
});

test("nextEpisodePromptStart sem outro: 90s antes do fim em episódio de mais de 40 min", () => {
  assert.equal(nextEpisodePromptStart([OPENING], 3000), 2910);
});

test("nextEpisodePromptStart é null quando a duração é desconhecida", () => {
  assert.equal(nextEpisodePromptStart([OPENING], 0), null);
  assert.equal(nextEpisodePromptStart([OPENING], NaN), null);
});

test("skipButtonVisible: null sem bloco ativo", () => {
  assert.equal(skipButtonVisible(null, 5, true), false);
  assert.equal(skipButtonVisible(null, 5, false), false);
});

test("skipButtonVisible: nos primeiros 10s do bloco, aparece mesmo com controles ocultos", () => {
  assert.equal(skipButtonVisible(OPENING, 0, false), true);
  assert.equal(skipButtonVisible(OPENING, 9.9, false), true);
});

test("skipButtonVisible: depois dos 10s, segue os controles", () => {
  assert.equal(skipButtonVisible(OPENING, 10, false), false);
  assert.equal(skipButtonVisible(OPENING, 10, true), true);
  assert.equal(skipButtonVisible(OPENING, 50, true), true);
});

test("nextEpisodePromptState: escondido antes do início do cartão", () => {
  const state = nextEpisodePromptState(1300, 1290, 1400, false);
  assert.equal(state.visible, false);
});

test("nextEpisodePromptState: contagem regressiva acompanha a posição", () => {
  assert.equal(nextEpisodePromptState(1300, 1300, 1400, false).countdownSeconds, 5);
  assert.equal(nextEpisodePromptState(1300, 1301, 1400, false).countdownSeconds, 4);
  assert.equal(nextEpisodePromptState(1300, 1304.2, 1400, false).countdownSeconds, 1);
});

test("nextEpisodePromptState: dispara o autoplay quando a contagem chega a zero", () => {
  const state = nextEpisodePromptState(1300, 1305, 1400, false);
  assert.equal(state.countdownSeconds, 0);
  assert.equal(state.triggerAutoplay, true);
  assert.equal(state.visible, true);
});

test("nextEpisodePromptState: cancelado fica escondido mesmo dentro da janela", () => {
  assert.equal(nextEpisodePromptState(1300, 1305, 1400, true).visible, false);
});

test("nextEpisodePromptState: sem prompt (sem outro nem duração) fica escondido", () => {
  assert.equal(nextEpisodePromptState(null, 1305, 1400, false).visible, false);
});

test("nextEpisodePromptState: some depois do fim do vídeo", () => {
  assert.equal(nextEpisodePromptState(1300, 1400, 1400, false).visible, false);
});

test("shouldResetNextEpisodeCancel: true quando o usuário voltou para antes do início do cartão", () => {
  assert.equal(shouldResetNextEpisodeCancel(1300, 1200), true);
});

test("shouldResetNextEpisodeCancel: false dentro ou depois da janela, ou sem prompt", () => {
  assert.equal(shouldResetNextEpisodeCancel(1300, 1305), false);
  assert.equal(shouldResetNextEpisodeCancel(null, 100), false);
});

test("sem encerramento conhecido, o cartão permite pular manualmente sem disparar autoplay", () => {
  const duration = 1_500;
  const promptStart = nextEpisodePromptStart([], duration);
  const countdownStart = nextEpisodeCountdownStart([], duration);
  assert.equal(promptStart, 1_455);
  assert.equal(countdownStart, null);
  const early = nextEpisodePromptState(promptStart, 1_456, duration, false, countdownStart);
  assert.equal(early.visible, true);
  assert.equal(early.triggerAutoplay, false);
  assert.equal(nextEpisodePromptState(promptStart, 1_460, duration, false, countdownStart).triggerAutoplay, false);
  assert.equal(nextEpisodePromptState(promptStart, 1_499, duration, false, countdownStart).triggerAutoplay, false);
});

test("com encerramento conhecido, a contagem começa junto com o cartão", () => {
  const blocks = [{ kind: "outro" as const, start: 1_300, end: 1_390, episodeLength: 1_430 }];
  assert.equal(nextEpisodeCountdownStart(blocks, 1_430), 1_300);
});

test("encerramento não confiável é ignorado: cai nos últimos segundos do arquivo", () => {
  const cedo = [{ kind: "outro" as const, start: 90, end: 180, episodeLength: null }];
  assert.equal(nextEpisodePromptStart(cedo, 1_440), 1_395);
  assert.equal(nextEpisodeCountdownStart(cedo, 1_440), null);
  const outroArquivo = [{ kind: "outro" as const, start: 1_300, end: 1_390, episodeLength: 2_600 }];
  assert.equal(nextEpisodePromptStart(outroArquivo, 1_430), 1_385);
});

test("sem duração conhecida, nem o encerramento abre o cartão", () => {
  const blocks = [{ kind: "outro" as const, start: 1_300, end: 1_390, episodeLength: 1_430 }];
  assert.equal(nextEpisodePromptStart(blocks, 0), null);
  assert.equal(nextEpisodeCountdownStart(blocks, NaN), null);
});

// ---------------------------------------------------------------------------
// shouldAutoSkipOpening (task 4)
// ---------------------------------------------------------------------------

test("shouldAutoSkipOpening: sem bloco ativo, nunca dispara", () => {
  assert.equal(shouldAutoSkipOpening(null, 5, new Set()), false);
});

test("shouldAutoSkipOpening: bloco 'outro' nunca dispara (só abertura tem auto-skip)", () => {
  assert.equal(shouldAutoSkipOpening(OUTRO, OUTRO.start, new Set()), false);
});

test("shouldAutoSkipOpening: dispara ao entrar naturalmente (posição perto do início do bloco)", () => {
  assert.equal(shouldAutoSkipOpening(OPENING, OPENING.start, new Set()), true);
  assert.equal(shouldAutoSkipOpening(OPENING, OPENING.start + 2.9, new Set()), true);
});

test("shouldAutoSkipOpening: não dispara quando a pessoa deu seek para o meio do bloco", () => {
  assert.equal(shouldAutoSkipOpening(OPENING, OPENING.start + 30, new Set()), false);
});

test("shouldAutoSkipOpening: não dispara de novo para um bloco já marcado (auto-skip ou 'Voltar')", () => {
  const jaTratado = new Set([OPENING.start]);
  assert.equal(shouldAutoSkipOpening(OPENING, OPENING.start, jaTratado), false);
});

// ---------------------------------------------------------------------------
// segmentsFromChapters (task 5 — fallback de capítulos MKV via libVLC)
// ---------------------------------------------------------------------------

function chapter(name: string, start: number, end: number): NativeChapter {
  return { name, start, end };
}

test("segmentsFromChapters: reconhece abertura em português e inglês", () => {
  assert.deepEqual(segmentsFromChapters([chapter("OP", 0, 90)]), [{ kind: "intro", start: 0, end: 90, episodeLength: null }]);
  assert.deepEqual(segmentsFromChapters([chapter("Opening", 0, 90)]), [{ kind: "intro", start: 0, end: 90, episodeLength: null }]);
  assert.deepEqual(segmentsFromChapters([chapter("Abertura", 0, 90)]), [{ kind: "intro", start: 0, end: 90, episodeLength: null }]);
});

test("segmentsFromChapters: reconhece encerramento em português e inglês", () => {
  assert.deepEqual(segmentsFromChapters([chapter("ED", 1300, 1350)]), [{ kind: "outro", start: 1300, end: 1350, episodeLength: null }]);
  assert.deepEqual(segmentsFromChapters([chapter("Ending", 1300, 1350)]), [{ kind: "outro", start: 1300, end: 1350, episodeLength: null }]);
  assert.deepEqual(segmentsFromChapters([chapter("Encerramento", 1300, 1350)]), [{ kind: "outro", start: 1300, end: 1350, episodeLength: null }]);
  assert.deepEqual(segmentsFromChapters([chapter("Créditos", 1300, 1350)]), [{ kind: "outro", start: 1300, end: 1350, episodeLength: null }]);
});

test("segmentsFromChapters: reconhece recapitulação em qualquer posição do nome", () => {
  assert.deepEqual(segmentsFromChapters([chapter("Previously on...", 0, 40)]), [{ kind: "recap", start: 0, end: 40, episodeLength: null }]);
  assert.deepEqual(segmentsFromChapters([chapter("Recap", 0, 40)]), [{ kind: "recap", start: 0, end: 40, episodeLength: null }]);
  assert.deepEqual(segmentsFromChapters([chapter("Anteriormente", 0, 40)]), [{ kind: "recap", start: 0, end: 40, episodeLength: null }]);
});

test("segmentsFromChapters: ignora capítulos sem nome reconhecível", () => {
  assert.deepEqual(segmentsFromChapters([chapter("Chapter 3", 400, 900), chapter("Part A", 0, 100)]), []);
});

test("segmentsFromChapters: mistura reconhecidos e ignorados, preservando só os primeiros", () => {
  const result = segmentsFromChapters([chapter("Intro", 0, 90), chapter("Chapter 2", 90, 1200), chapter("Ending", 1200, 1260)]);
  assert.deepEqual(result, [
    { kind: "intro", start: 0, end: 90, episodeLength: null },
    { kind: "outro", start: 1200, end: 1260, episodeLength: null }
  ]);
});

test("capítulos de prévia e encerramento viram 'outro'; nomes parecidos não", () => {
  const segments = segmentsFromChapters([
    { name: "Preview", start: 1_390, end: 1_431 },
    { name: "Next Episode", start: 1_400, end: 1_431 },
    { name: "予告", start: 1_410, end: 1_431 },
    { name: "Resumo", start: 20, end: 80 },
    { name: "Edward's Plan", start: 600, end: 700 }
  ]);
  assert.deepEqual(segments.map((segment) => `${segment.kind}@${segment.start}`),
    ["outro@1390", "outro@1400", "outro@1410", "recap@20"]);
});

test("abertura e resumo preservam identificação e intervalos dentro da mesma ação", () => {
  const intro = segment("intro", 10, 100);
  const recap = segment("recap", 101, 220);
  const blocks = playbackSkipBlocks([intro, recap]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0]?.segments, [intro, recap]);
  assert.equal(blocks[0]?.end, 220);
  assert.equal(skipBlockLabel(blocks[0]!), "Pular abertura e resumo");
  assert.equal(skipBlockLabel(playbackSkipBlocks([recap])[0]!), "Pular resumo");
  assert.equal(skipBlockLabel(playbackSkipBlocks([intro])[0]!), "Pular abertura");
});

test("identificação separada preserva a história entre abertura e resumo distantes", () => {
  const blocks = playbackSkipBlocks([segment("intro", 10, 100), segment("recap", 140, 200)]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.end, 100);
  assert.equal(activeSkipSegment(blocks, 120, 1430), null);
});

test("ended no meio do vídeo ou sem duração não avança; fim real continua automático", () => {
  assert.equal(canAdvanceOnEnded(700, 1400), false);
  assert.equal(canAdvanceOnEnded(0, 0), false);
  assert.equal(canAdvanceOnEnded(NaN, 1400), false);
  assert.equal(canAdvanceOnEnded(1398, 1400), true);
  assert.equal(canAdvanceOnEnded(1400, 1400), true);
});

test("abertura identificada tarde ainda pula; seek manual e bloco já tratado continuam protegidos", () => {
  assert.equal(shouldAutoSkipOpening(OPENING, OPENING.start + 20, new Set(), true), true);
  assert.equal(shouldAutoSkipOpening(OPENING, OPENING.start + 20, new Set(), false), false);
  assert.equal(shouldAutoSkipOpening(OPENING, OPENING.start + 20, new Set([OPENING.start]), true), false);
  assert.equal(shouldAutoSkipOpening(OPENING, OPENING.end, new Set(), true), false);
  assert.equal(shouldAutoSkipOpening(OPENING, OPENING.start - 1, new Set(), true), false);
});


test("voltar manualmente mantém o botão de abertura mesmo com controles ocultos", () => {
  assert.equal(skipButtonVisible(OPENING, 50, false, true), true);
  assert.equal(skipButtonVisible(null, 500, false, true), false);
});

test("buscar no encerramento oferece próximo episódio sem disparo imediato ou ao chegar ao fim", () => {
  for (const position of [1300, 1350, 1400]) {
    const manual = isManualEndingVisit(1300, position, 1300);
    assert.equal(manual, true);
    const prompt = nextEpisodePromptState(1300, position, 1400, false, 1300, manual);
    assert.equal(prompt.visible, true);
    assert.equal(prompt.triggerAutoplay, false);
  }
  assert.equal(nextEpisodePromptState(1300, 1400, 1400, false, null, true).visible, true);
});

test("buscar no meio e chegar naturalmente ao encerramento preserva o avanço automático", () => {
  assert.equal(isManualEndingVisit(1300, 1350, 500), false);
  assert.equal(isManualEndingVisit(1300, 1350, null), false);
  assert.equal(isManualEndingVisit(null, 1350, 1350), false);
  assert.equal(isManualEndingVisit(1300, 500, 1350), false);
  assert.equal(nextEpisodePromptState(1300, 1305, 1400, false, 1300, false).triggerAutoplay, true);
});

test("cancelamento manual esconde cartão, nova busca com cancelamento limpo volta a mostrá-lo", () => {
  assert.equal(nextEpisodePromptState(1300, 1350, 1400, true, 1300, true).visible, false);
  assert.equal(nextEpisodePromptState(1300, 1360, 1400, false, 1300, true).visible, true);
});
