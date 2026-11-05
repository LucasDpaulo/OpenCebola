import type { Book, BookTrends } from "@cebola/contracts";
import type { DownloadBook } from "./catalog.js";

// Seleção verificada em 09/10/2026. Continua acessível quando a API pública do Gutendex cai.
export const classicDownloads = [
  { id: 67162, title: "Helena", author: "Machado de Assis", description: "A chegada de Helena à família de Estácio revela sentimentos e segredos em um romance de Machado de Assis." },
  { id: 55752, title: "Dom Casmurro", author: "Machado de Assis", description: "As memórias de Bentinho, sua relação com Capitu e as dúvidas de um narrador que desafia o leitor." },
  { id: 54829, title: "Memórias Póstumas de Brás Cubas", author: "Machado de Assis", description: "Um defunto-autor revisita sua vida com a ironia e a crítica social de Machado de Assis." },
  { id: 69187, title: "O Cortiço", author: "Aluísio Azevedo", description: "Romance naturalista sobre a vida coletiva em um cortiço do Rio de Janeiro." }
].map((entry): DownloadBook => ({
  epubUrl: `https://www.gutenberg.org/cache/epub/${entry.id}/pg${entry.id}-images-3.epub`,
  book: { id: `gutenberg-${entry.id}`, title: entry.title, authors: [entry.author], language: "pt",
    description: entry.description, coverUrl: `https://www.gutenberg.org/cache/epub/${entry.id}/pg${entry.id}.cover.medium.jpg`,
    source: "Project Gutenberg", sourceUrl: `https://www.gutenberg.org/ebooks/${entry.id}`, format: "EPUB", subjects: ["fiction", "brazil"] }
}));

// Obra, autoria e capa conferidas na Open Library em 23/10/2026.
const selectedWorks = [
  {
    "id": "ol-OL1525650W",
    "title": "Iracema",
    "author": "José de Alencar",
    "cover": 2664651,
    "northeast": true
  },
  {
    "id": "ol-OL2900596W",
    "title": "Vidas secas",
    "author": "Graciliano Ramos",
    "cover": 12369687,
    "northeast": true
  },
  {
    "id": "ol-OL20301301W",
    "title": "O Quinze",
    "author": "Rachel de Queiroz",
    "cover": 8960570,
    "northeast": true
  },
  {
    "id": "ol-OL1248157W",
    "title": "Capitães da Areia",
    "author": "Jorge Amado",
    "cover": 4178919,
    "northeast": true
  },
  {
    "id": "ol-OL1011741W",
    "title": "Auto da Compadecida",
    "author": "Ariano Suassuna",
    "cover": 3908450,
    "northeast": true
  },
  {
    "id": "ol-OL2306387W",
    "title": "Triste fim de Policarpo Quaresma",
    "author": "Lima Barreto",
    "cover": 5459319,
    "northeast": false
  },
  {
    "id": "ol-OL1525639W",
    "title": "O guarani",
    "author": "José de Alencar",
    "cover": 5271115,
    "northeast": false
  }
] as const;
export const classicDiscovery: Book[] = selectedWorks.map((entry) => ({
  id: entry.id, title: entry.title, authors: [entry.author], language: "pt",
  description: "Clássico da literatura brasileira. Consulte na fonte as edições e opções de acesso.",
  coverUrl: `https://covers.openlibrary.org/b/id/${entry.cover}-M.jpg`,
  source: "Open Library", sourceUrl: `https://openlibrary.org/works/${entry.id.slice(3)}`,
  format: "SOURCE", subjects: ["fiction", "brazil"]
}));
export function classicSections(): BookTrends["sections"] {
  const northeast = new Set<string>(selectedWorks.filter((entry) => entry.northeast).map((entry) => entry.id));
  const epubBooks = classicDownloads.map(({ book }) => book);
  const base = { source: "Seleção de clássicos · Gutenberg e Open Library", sourceUrl: "https://openlibrary.org/", period: null, fetchedAt: null, stale: false, notice: null };
  return [
    { ...base, id: "classics-brazil", title: "Clássicos brasileiros", items: [...epubBooks, ...classicDiscovery.filter((book) => !northeast.has(book.id))] },
    { ...base, id: "classics-northeast", title: "Clássicos nordestinos", items: [...classicDiscovery.filter((book) => northeast.has(book.id)), ...epubBooks.filter((book) => book.id === "gutenberg-69187")] }
  ];
}
