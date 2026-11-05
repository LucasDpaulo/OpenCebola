import { Capacitor, registerPlugin } from "@capacitor/core";

const BookDownloads = registerPlugin<{ save(options: { base64: string; filename: string }): Promise<{ saved: boolean }>; kindle(options: { base64: string; filename: string }): Promise<{ opened: boolean }> }>("BookDownloads");

export function bookFilename(title: string): string {
  const safe = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9 -]/g, "").trim().replace(/\s+/g, "-").slice(0, 100);
  return `${safe || "livro"}.epub`;
}

export async function saveBook(blob: Blob, title: string): Promise<"saved" | "started" | "cancelled"> {
  const filename = bookFilename(title);
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
    if (!Capacitor.isPluginAvailable("BookDownloads")) {
      throw new Error("Atualize o aplicativo para salvar livros. Você também pode baixar pelo navegador do celular.");
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
      reader.onerror = () => reject(new Error("Não foi possível preparar o arquivo para salvar."));
      reader.readAsDataURL(blob);
    });
    return (await BookDownloads.save({ base64, filename })).saved ? "saved" : "cancelled";
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // O Safari pode consumir a URL depois do clique. Não revogar antes de começar o download.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "started";
}

export async function sendBookToKindle(blob: Blob, title: string): Promise<"opened" | "shared" | "saved" | "started" | "cancelled"> {
  const filename = bookFilename(title);
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
    if (!Capacitor.isPluginAvailable("BookDownloads")) throw new Error("Atualize o Cebola para enviar livros ao Kindle.");
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
      reader.onerror = () => reject(new Error("Não foi possível preparar o livro."));
      reader.readAsDataURL(blob);
    });
    await BookDownloads.kindle({ base64, filename });
    return "opened";
  }
  const file = new File([blob], filename, { type: "application/epub+zip" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return "shared"; }
    catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
      // Alguns navegadores perdem a ativação do toque durante o download.
    }
  }
  return saveBook(blob, title);
}

export function kindleNotice(result: Awaited<ReturnType<typeof sendBookToKindle>>): string {
  if (result === "opened") return "Confirme o envio no Kindle. O livro aparecerá na biblioteca após o processamento da Amazon.";
  if (result === "shared") return "Se você escolheu o Kindle, confirme o envio no aplicativo da Amazon.";
  if (result === "cancelled") return "Envio cancelado. Você pode tentar novamente.";
  return "EPUB salvo ou download iniciado. Use Enviar para Kindle abaixo para importar o arquivo.";
}
