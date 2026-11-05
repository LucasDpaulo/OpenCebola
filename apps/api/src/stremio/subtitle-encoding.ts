// Windows-1252 (que também cobre o Latin-1) nos dois sentidos: byte → caractere e caractere → byte.
// Montado à mão: o TextDecoder("windows-1252") do Node decodifica como Latin-1, e 0x80–0x9F
// (aspas curvas, travessão, reticências, €) viravam caracteres de controle invisíveis.
const CP1252 = String.fromCharCode(...Array.from({ length: 0x80 }, (_, byte) => byte)) +
  "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f" +
  "\u0090‘’“”•–—˜™š›œ\u009džŸ" +
  String.fromCharCode(...Array.from({ length: 0x60 }, (_, offset) => 0xa0 + offset));
const CP1252_BYTES = new Map([...CP1252].map((char, byte) => [char, byte]));

// O par que um caractere UTF-8 de 2 bytes vira quando é lido como 1252: "Ã¡", "Ã§", "Ã£".
const MOJIBAKE = /[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-‚“-„†-•…‰‹›€™]/;

/** Tamanho da sequência UTF-8 válida que começa em `index`, ou 0 se o byte não abre uma. */
function utf8SequenceLength(bytes: Uint8Array, index: number): number {
  const lead = bytes[index]!;
  const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  if (length === 0 || index + length > bytes.length) return 0;
  for (let offset = 1; offset < length; offset += 1) {
    if ((bytes[index + offset]! & 0xc0) !== 0x80) return 0;
  }
  const second = bytes[index + 1]!;
  // Formas longas, surrogates e acima de U+10FFFF não são UTF-8 válido.
  if ((lead === 0xe0 && second < 0xa0) || (lead === 0xed && second > 0x9f) ||
    (lead === 0xf0 && second < 0x90) || (lead === 0xf4 && second > 0x8f)) return 0;
  return length;
}

/**
 * Arquivo com bytes fora do UTF-8 nem sempre é 1252 do começo ao fim: legenda editada por mais
 * de uma pessoa mistura as duas. Lido inteiro como 1252, todo "á" UTF-8 aparecia como "Ã¡";
 * aqui cada sequência UTF-8 válida continua UTF-8 e só os bytes soltos são lidos como 1252.
 */
export function decodeMixedUtf8(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8");
  let result = "";
  let start = 0;
  let index = 0;
  while (index < bytes.length) {
    if (bytes[index]! < 0x80) { index += 1; continue; }
    const length = utf8SequenceLength(bytes, index);
    if (length > 0) { index += length; continue; }
    result += utf8.decode(bytes.subarray(start, index)) + CP1252[bytes[index]!];
    index += 1;
    start = index;
  }
  return result + utf8.decode(bytes.subarray(start));
}

/**
 * Há legenda publicada já estragada: UTF-8 lido como 1252 e salvo de novo ("JÃ¡ estÃ¡"). O arquivo
 * é UTF-8 válido, então só o texto denuncia. O texto inteiro volta aos bytes 1252 e, se eles
 * formarem UTF-8 válido, a versão decodificada vale. Texto correto nunca passa nesse teste: um
 * acento sozinho seguido de letra comum não forma sequência UTF-8.
 */
export function repairDoubleEncodedUtf8(text: string): string {
  if (!MOJIBAKE.test(text)) return text;
  const bytes = new Uint8Array(text.length);
  let length = 0;
  for (const char of text) {
    const byte = CP1252_BYTES.get(char);
    if (byte === undefined) return text;
    bytes[length++] = byte;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } catch {
    return text;
  }
}
