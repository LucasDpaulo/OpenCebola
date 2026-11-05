// Padrões de codec — UM lugar só, e sem dependências
// ------------------------------------------------------------------------------------------
// Este arquivo é importado pelo servidor E pelo navegador. Ele não importa nada, de propósito:
// assim o cliente pega os padrões sem arrastar zod para o bundle.
// Estes padrões viviam copiados no gateway, na rota de resolve e no cliente. As cópias já
// divergiram na prática: a do cliente usava \bddp?\b, que NÃO casa com "DD5.1", enquanto a do
// servidor usava \bddp?(?:\d|\b), que casa. O efeito era escolher no Linux um release Dolby
// Digital achando que era seguro — vídeo abre, som não sai. Divergência de cópia não se resolve
// com atenção, se resolve tirando as cópias.
//
// Nada aqui é veredito: é o palpite lido do NOME do arquivo. Quem decide se toca é o navegador,
// via canPlayType, no aparelho de quem está assistindo.

/** HEVC/x265 e Dolby Vision. Sem decodificador, o sintoma é tela preta — não é erro. */
export const HEVC_PATTERN = /h[.\s]?265|x265|hevc|dolby\s*vision/i;

/** AC3, EAC3, DD/DDP, Atmos, DTS e TrueHD. Sem decodificador, o vídeo abre e o som não sai. */
export const DOLBY_AUDIO_PATTERN =
  /e[.-]?ac-?3|\bac-?3\b|\bddp?(?:\d|\b)|dd\+|dolby\s*digital(?:\s*plus)?|atmos|\bdts(?:-hd)?\b|truehd/i;

/**
 * Pista de áudio multicanal SEM codec declarado: "5.1", "7.1", "2.0".
 *
 * Não é veredito, é probabilidade — e ela é alta. Medido em The Bear S01E01, onde NENHUMA das 11
 * fontes declara codec de áudio: as candidatas dizem "Ita Eng Spa 5.1" e o resultado é vídeo
 * mudo. Na prática, release multicanal em torrent é AC3/EAC3/DTS; o áudio que o navegador
 * decodifica (AAC) costuma vir em estéreo 2.0.
 *
 * Por isso NÃO entra em MAY_NOT_PLAY_PATTERN: serve para desempatar na escolha automática, não
 * para acender aviso nem para declarar que a fonte não toca.
 */
// O que vem imediatamente antes não pode ser letra nem dígito: assim "v5.1" e "DDP5.1" não
// casam, mas o formato muito comum separado por pontos ("WEB-DL.5.1.x264") continua detectado.
export const MULTICHANNEL_HINT_PATTERN = /(?<!\w)[57]\.1(?![\d])/;

/** Gravação feita na sala de cinema, ou cópia de avaliação. A pior imagem que existe. */
export const CAM_PATTERN =
  /\bcam\b|\bcamrip\b|\bhq[-.\s]?cam\b|\bhd[-.\s]?cam\b|\btele[-.\s]?sync\b|\bhd[-.\s]?ts\b|\bhdts\b|\btelecine\b|\bhdtc\b|\bscreener\b|\bdvd[-.\s]?scr\b/i;

/** Um dos dois acima: o palpite de que o navegador pode não dar conta. */
export const MAY_NOT_PLAY_PATTERN = new RegExp(
  `${HEVC_PATTERN.source}|\\bdv\\b|${DOLBY_AUDIO_PATTERN.source}`,
  "i"
);
