import assert from "node:assert/strict";
import test from "node:test";
import { categoryForBook, readBooks, recommendedCategory, saveReading, updateReading } from "../app/livros/reading-list.js";
import type { Book } from "@cebola/contracts";
const book: Book = { id: "eloquent-javascript", title: "JavaScript", authors: [], language: "en", description: "", coverUrl: null, source: "Autor", sourceUrl: "https://eloquentjavascript.net/", format: "EPUB" };
test("estante altera status sem duplicar e separa perfis", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const wanted = updateReading([], book, "wanted", "technology");
  const reading = updateReading(wanted, book, "reading", "technology");
  assert.equal(reading.length, 1);
  assert.equal(reading[0]?.status, "reading");
  saveReading("a", reading, storage);
  assert.deepEqual(readBooks("a", storage), reading);
  assert.deepEqual(readBooks("b", storage), []);
  assert.deepEqual(updateReading(reading, book, null, "technology"), []);
  data.set("cebola:books:v1:a", "broken");
  assert.deepEqual(readBooks("a", storage), []);
});
test("recomendação prioriza leitura atual e não inventa gênero sem metadados", () => {
  const entries = updateReading([], book, "reading", "technology");
  assert.equal(recommendedCategory(entries), "technology");
  assert.equal(recommendedCategory(updateReading(entries, book, "finished", "technology")), null);
  assert.equal(categoryForBook(book, "all"), "technology");
  assert.equal(categoryForBook({ ...book, id: "gutenberg-999", subjects: ["Detective and mystery stories"] }, "all"), "mystery");
  assert.equal(categoryForBook({ ...book, id: "gutenberg-999" }, "all"), "all");
});
