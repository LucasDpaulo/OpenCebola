import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BookError } from "./remote.js";
import { readEpub, MAX_EPUB_BYTES } from "./epub.js";

const execute = promisify(execFile);
export type ConversionRunner = (command: string, args: string[], directory: string) => Promise<void>;
const run: ConversionRunner = async (command, args, directory) => {
  await execute(command, args, { cwd: directory, timeout: 90_000, killSignal: "SIGKILL", maxBuffer: 2_097_152,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, LANG: "C.UTF-8", QT_QPA_PLATFORM: "offscreen" } });
};
export async function convertPdf(pdf: Buffer, runner: ConversionRunner = run): Promise<Buffer> {
  if (pdf.length < 8 || pdf.length > MAX_EPUB_BYTES || pdf.subarray(0, 5).toString() !== "%PDF-") {
    throw new BookError("BOOK_PDF_INVALID", 422, "Selecione um PDF válido de até 25 MB.");
  }
  const directory = await mkdtemp(join(tmpdir(), "cebola-convert-"));
  try {
    const input = join(directory, "input.pdf");
    const text = join(directory, "text.txt");
    const output = join(directory, "book.epub");
    await writeFile(input, pdf, { mode: 0o600 });
    await runner("pdftotext", ["-f", "1", "-l", "20", input, text], directory);
    if ((await stat(text)).size > MAX_EPUB_BYTES) throw new BookError("BOOK_TOO_LARGE", 413, "Este PDF contém texto demais para a conversão.");
    if ((await readFile(text, "utf8")).replace(/\s/g, "").length < 100) {
      throw new BookError("BOOK_PDF_NEEDS_OCR", 422, "Não encontramos texto suficiente neste PDF. PDFs escaneados precisam de OCR antes da conversão.");
    }
    await runner("ebook-convert", [input, output, "--output-profile", "tablet", "--base-font-size", "12",
      "--margin-left", "12", "--margin-right", "12", "--margin-top", "12", "--margin-bottom", "12",
      "--minimum-line-height", "120", "--extra-css", "body { line-height: 1.4; } img { max-width: 100%; height: auto; } pre { white-space: pre-wrap; }"], directory);
    if ((await stat(output)).size > MAX_EPUB_BYTES) throw new BookError("BOOK_TOO_LARGE", 413, "O EPUB convertido ultrapassou 25 MB.");
    const epub = await readFile(output);
    await readEpub(epub);
    return epub;
  } catch (error) {
    if (error instanceof BookError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new BookError("BOOK_CONVERTER_UNAVAILABLE", 503, "O conversor de PDF ainda não está disponível neste servidor.");
    }
    throw new BookError("BOOK_CONVERSION_FAILED", 422, "Não foi possível converter este PDF. Ele pode estar protegido, danificado ou exigir tratamento manual.");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
