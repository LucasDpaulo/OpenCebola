import path from "node:path";
import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import { unzipSync, zipSync, strFromU8, strToU8, type Unzipped, type Zippable } from "fflate";
import { BookError } from "./remote.js";

const OPF = "http://www.idpf.org/2007/opf";
const MAX_EXPANDED = 80 * 1024 * 1024;
export const MAX_EPUB_BYTES = 25 * 1024 * 1024;
function invalid(): never { throw new BookError("BOOK_FILE_INVALID", 422, "Não foi possível verificar o EPUB e sua capa. Tente outro livro."); }
function parseXml(bytes: Uint8Array | undefined): Document {
  if (!bytes || bytes.length > 2_097_152) invalid();
  const text = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) invalid();
  return new DOMParser({ onError: () => invalid() }).parseFromString(text, "application/xml");
}
function elements(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", name));
}
function filePath(base: string, href: string): string {
  if (!href || /[?#\\\u0000]/.test(href) || /^[a-z]+:|^\//i.test(href)) invalid();
  let decoded: string;
  try { decoded = decodeURIComponent(href); } catch { return invalid(); }
  const result = path.posix.normalize(path.posix.join(base, decoded));
  if (result.startsWith("../") || result.startsWith("/") || result.includes("\\")) invalid();
  return result;
}
function imageType(bytes: Uint8Array | undefined): "image/jpeg" | "image/png" | null {
  if (!bytes || bytes.length < 16 || bytes.length > 5 * 1024 * 1024) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  return null;
}
export async function readEpub(bytes: Uint8Array): Promise<Unzipped> {
  if (bytes.length > MAX_EPUB_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x4b) invalid();
  let count = 0, size = 0;
  const names = new Set<string>();
  const files = unzipSync(bytes, { filter: (entry) => {
      size += entry.originalSize;
      if (++count > 3000 || size > MAX_EXPANDED || names.has(entry.name) ||
        entry.name.includes("\\") || entry.name.startsWith("/") || entry.name.split("/").includes("..")) invalid();
      names.add(entry.name);
      return true;
    } });
  if (!files.mimetype || strFromU8(files.mimetype).trim() !== "application/epub+zip") invalid();
  if (Object.values(files).reduce((total, data) => total + data.length, 0) > MAX_EXPANDED) invalid();
  return files;
}

/** Preserva capítulos, estilos, sumário e créditos. Só normaliza a identificação da capa. */
export async function prepareEpub(bytes: Uint8Array, fallbackCover: () => Promise<Uint8Array>): Promise<Buffer> {
  const files = await readEpub(bytes);
  const container = parseXml(files["META-INF/container.xml"]);
  const rootfile = elements(container, "rootfile")[0]?.getAttribute("full-path");
  if (!rootfile) invalid();
  const opfPath = filePath("", rootfile);
  const opf = parseXml(files[opfPath]);
  const pkg = opf.documentElement;
  const manifest = elements(opf, "manifest")[0];
  const metadata = elements(opf, "metadata")[0];
  const spine = elements(opf, "spine")[0];
  if (!pkg || !manifest || !metadata || !spine || !elements(spine, "itemref").length) invalid();
  const epub3 = Number(pkg.getAttribute("version")) >= 3;
  const base = path.posix.dirname(opfPath);
  const items = elements(manifest, "item");
  const coverMeta = elements(metadata, "meta").filter((node) => node.getAttribute("name") === "cover");
  const coverIds = new Set(coverMeta.map((node) => node.getAttribute("content")));
  const candidates = items.filter((node) => (node.getAttribute("properties") ?? "").split(/\s+/).includes("cover-image") || coverIds.has(node.getAttribute("id")));
  candidates.push(...items.filter((node) => /^image\/(jpeg|png)$/.test(node.getAttribute("media-type") ?? "") && /cover/i.test(node.getAttribute("href") ?? "")));
  let cover: Element | undefined;
  for (const candidate of candidates) {
    const type = imageType(files[filePath(base, candidate.getAttribute("href") ?? "")]);
    if (type && candidate.getAttribute("id")) { cover = candidate; cover.setAttribute("media-type", type); break; }
  }
  const usedIds = new Set(items.map((node) => node.getAttribute("id")));
  const uniqueId = (stem: string) => { let id = stem; while (usedIds.has(id)) id += "-1"; usedIds.add(id); return id; };
  const make = (name: string, attrs: Record<string, string>) => {
    const node = opf.createElementNS(OPF, pkg.prefix ? `${pkg.prefix}:${name}` : name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  if (!cover) {
    const image = await fallbackCover();
    const type = imageType(image);
    if (!type) invalid();
    let href = `cebola-cover.${type === "image/png" ? "png" : "jpg"}`;
    while (files[filePath(base, href)]) href = `_${href}`;
    files[filePath(base, href)] = new Uint8Array(image);
    cover = make("item", { id: uniqueId("cebola-cover-image"), href, "media-type": type });
    manifest.appendChild(cover);
  }
  for (const item of items) {
    const properties = (item.getAttribute("properties") ?? "").split(/\s+/).filter((value) => value && value !== "cover-image");
    if (properties.length) item.setAttribute("properties", properties.join(" "));
    else item.removeAttribute("properties");
  }
  if (epub3) cover.setAttribute("properties", `${cover.getAttribute("properties") ?? ""} cover-image`.trim());
  for (const node of coverMeta) metadata.removeChild(node);
  metadata.appendChild(make("meta", { name: "cover", content: cover.getAttribute("id")! }));

  // Uma página de capa para leitores que usam a primeira página em vez do metadado.
  const hasCoverPage = elements(opf, "reference").some((node) => node.getAttribute("type") === "cover") ||
    items.some((node) => node.getAttribute("media-type") === "application/xhtml+xml" && /cover/i.test(`${node.getAttribute("id")} ${node.getAttribute("href")}`));
  if (!hasCoverPage) {
    let href = "cebola-cover.xhtml";
    while (files[filePath(base, href)]) href = `_${href}`;
    const id = uniqueId("cebola-cover-page");
    const coverDocument = new DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Capa</title><style>body{margin:0;padding:0;text-align:center}img{max-width:100%;max-height:100%;height:auto}</style></head><body><div><img alt="Capa do livro" /></div></body></html>', "application/xhtml+xml");
    elements(coverDocument, "img")[0]!.setAttribute("src", cover.getAttribute("href")!);
    files[filePath(base, href)] = strToU8(new XMLSerializer().serializeToString(coverDocument));
    manifest.appendChild(make("item", { id, href, "media-type": "application/xhtml+xml" }));
    spine.insertBefore(make("itemref", { idref: id }), spine.firstChild);
    let guide = elements(opf, "guide")[0];
    if (!guide) { guide = make("guide", {}); pkg.appendChild(guide); }
    guide.appendChild(make("reference", { type: "cover", title: "Capa", href }));
  }
  files[opfPath] = strToU8(new XMLSerializer().serializeToString(opf));
  // EPUB exige mimetype como PRIMEIRA entrada, sem compressão nem campo extra.
  const output: Zippable = { mimetype: [strToU8("application/epub+zip"), { level: 0 }] };
  for (const [name, data] of Object.entries(files)) if (name !== "mimetype") output[name] = data;
  const result = zipSync(output, { level: 6 });
  if (result.length > MAX_EPUB_BYTES) invalid();
  return Buffer.from(result);
}

export function epubFilename(title: string): string {
  const safe = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9 -]/g, "").trim().replace(/\s+/g, "-").slice(0, 100);
  return `${safe || "livro"}.epub`;
}
