/**
 * Casos de teste da matriz de codecs.
 *
 * GERADO, não escrito à mão: cada linha veio de `ffprobe` sobre os primeiros 3,5 MB do arquivo
 * real, servido pelo Real-Debrid em 26/08/2026. Os campos `video` e `audio` são o que o arquivo
 * TEM — não o que o nome promete. Metade dos releases mente ou omite, e foi por confiar no nome
 * que a matriz ficou seis dias sendo suposição.
 *
 * Todos já estavam em cache no Real-Debrid, então `resolve` devolve link na hora, sem espera e
 * sem risco de bloqueio por conteúdo.
 */

export type CasoDeTeste = {
  readonly hash: string;
  readonly fileIdx: number;
  readonly nome: string;
  readonly qualidade: string;
  readonly video: string;
  readonly audio: string;
};

export const CASOS: readonly CasoDeTeste[] = [
  { hash: "88a7b7b7a4d9c506beae52ad45ff5430d4468b9b", fileIdx: 0, nome: "Project.Hail.Mary.2026.2160p.4K.WEB.x265.10bit.AAC5.1-[YTS.BZ].mkv", qualidade: "4K", video: "hevc Main 10 3840w", audio: "aac/6ch" },
  { hash: "53a753e9cd62e8baa8dd79b543f2eda19bb72d65", fileIdx: 0, nome: "The.Bear.S02E01.2160p.WEB.h265-ETHEL.mkv", qualidade: "4K", video: "hevc Main 10 3840w", audio: "eac3/6ch" },
  { hash: "38c8df619f173e6672c197718234d66803f43563", fileIdx: 0, nome: "4K Avatar Aang Ostatni Władca Wiatru-The Legend of Aang The Last Airbe", qualidade: "4K", video: "h264 High 3840w", audio: "aac/2ch" },
  { hash: "e2ee70febb72657d0007eb176b2eb938bb052faa", fileIdx: 0, nome: "Interstellar.2014.bluray.hdr.2160p.av1.5.1.opus.subs-Dust.mkv", qualidade: "4K", video: "av1 Main 3840w", audio: "opus/6ch" },
  { hash: "c26f753911e2c24a82049368421423f3ab9d06d8", fileIdx: 0, nome: "Интерстеллар.2014.UHD.Blu-Ray.Remux.2160p.mkv", qualidade: "4K", video: "hevc Main 10 3840w", audio: "ac3/6ch + dts/6ch + dts/6ch + dts/6ch + dts/6ch + dts/6ch + dts/6ch + dts/6ch" },
  { hash: "e57f63452d89ebfadfeff70c695ab74adc2f65ba", fileIdx: 0, nome: "Minions.Monsters.2026.2160p.4K.WEB.x265.10bit.AAC5.1-[YTS.GG - YTS.BZ]", qualidade: "4K", video: "hevc Main 10 3840w", audio: "aac/6ch" },
  { hash: "23dc09ffa3310d21b22acb905d9a56d3b0cb864d", fileIdx: 0, nome: "Ted.Lasso.S01E01.HDR.2160p.WEB.H265-SKEDADDLE.mkv", qualidade: "4K", video: "hevc Main 10 3840w", audio: "eac3/6ch" },
  { hash: "bea4e2218c9a596be84f3208b980d863a821f116", fileIdx: 0, nome: "Project.Hail.Mary.2026.PROPER.HDR.2160p.WEB.h265-GRACE.mkv", qualidade: "4K", video: "hevc Main 10 3840w", audio: "eac3/6ch" },
  { hash: "095af843c27661bba2d4305be93da27b9f925d01", fileIdx: 7, nome: "The.Bear.S01e08.Ita.Eng.Spa.5.1.720p.h264.SubS-Me7alh.mkv", qualidade: "720p", video: "h264 High 1280w", audio: "ac3/6ch + ac3/6ch + ac3/6ch" },
  { hash: "c9b97d8f8a6ed4c111697b60fdfb8364404ba100", fileIdx: 0, nome: "Obsession.2025.1080p.MA-New-Team.mkv", qualidade: "1080p", video: "h264 High 1920w", audio: "ac3/2ch + ac3/2ch + ac3/6ch + eac3/6ch" },
  { hash: "6aec96170d34e54879bb00b8e2dfcc4577e86f75", fileIdx: 0, nome: "Obsession.2026.1080p.TELESYNC.x264-UNiON.mkv", qualidade: "1080p", video: "h264 High 1920w", audio: "ac3/2ch + ac3/2ch" },
  { hash: "cc2c473d1ae3127af6932ab36224a26e65cf902f", fileIdx: 0, nome: "Tony.2026.D.TS.1O8Op.mkv", qualidade: "outra", video: "h264 High 1920w", audio: "aac/2ch" },
  { hash: "6210d00680caaab0136ac1f5320eae47ea9c87eb", fileIdx: 34, nome: "The.Bear.S04E07.avi", qualidade: "outra", video: "mpeg4 Advanced Simple Profile 704w", audio: "mp3/2ch" },
  { hash: "8f267b32d43f48c7c0780f185717bb1453e9f011", fileIdx: 7, nome: "The.Bear.S01E08.WEBDL.1080p.RGzsRutracker.mkv", qualidade: "1080p", video: "h264 High 1920w", audio: "ac3/6ch + ac3/6ch + eac3/6ch" },
  { hash: "f983ff9e90ebba299be22ba3a56a57139cf72d01", fileIdx: 0, nome: "Mad Men (2007) - S06E01-E02 - The Doorway (1080p BluRay x265 LION).mkv", qualidade: "1080p", video: "hevc Main 10 1920w", audio: "aac/6ch" },
  { hash: "6bbad06245a0d631b0a5e47c8cd6e5abc9a70211", fileIdx: 0, nome: "Breaking.Bad.S01E01.Pilot.1080p.10bit.BluRay.6CH.x265.HEVC-PSA.mkv", qualidade: "1080p", video: "hevc Main 10 1920w", audio: "aac/6ch" },
  { hash: "33b1396389a7d76f57215ee618f0ce438126ebe4", fileIdx: 46, nome: "Breaking.Bad.S05E16.Felina.1080p.BluRay.10bit.HEVC.6CH-MkvCage.ws.mkv", qualidade: "1080p", video: "hevc Main 10 1920w", audio: "aac/6ch" },
  { hash: "2927019dbf67eb165347258c1f6d136d644efa4f", fileIdx: 0, nome: "Breaking.Bad.S01E01.Pilot.1080p.10bit.BluRay.x265.HEVC.6CH-MRN.mkv", qualidade: "1080p", video: "hevc Main 10 1920w", audio: "aac/6ch" },
  { hash: "4d4d7a3206e2a56bca52564f2c6efbb09a49daa4", fileIdx: 0, nome: "Spider-Man.Brand.New.Day.2026.V3.1080p.HDTS.x264 (1) (1).mkv", qualidade: "1080p", video: "h264 High 1920w", audio: "ac3/2ch" }
];
