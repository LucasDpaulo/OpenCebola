import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const exec = promisify(execFile);
const javaTool = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : name;
test('cache de vídeo é apagado sem atingir login, livros ou destino de symlink', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cebola-cache-test-'));
  try {
    const source = new URL('../android/app/src/main/java/br/cebola/app/TemporaryVideoStorage.java', import.meta.url).pathname;
    const harness = path.join(dir, 'StorageTest.java');
    await writeFile(harness, `
import java.io.*;
import java.nio.file.*;
import br.cebola.app.TemporaryVideoStorage;
public class StorageTest {
 public static void main(String[] args) throws Exception {
  Path base = Paths.get(args[0]);
  Path cache = Files.createDirectories(base.resolve("cache"));
  Path login = Files.writeString(cache.resolve("login"), "session");
  Path books = Files.createDirectories(base.resolve("books"));
  Path book = Files.writeString(books.resolve("book.epub"), "book");
  TemporaryVideoStorage storage = new TemporaryVideoStorage(cache.toFile());
  File first = storage.begin();
  Files.writeString(first.toPath().resolve("video.part"), "video");
  Files.createSymbolicLink(first.toPath().resolve("link"), books);
  storage.clear(); storage.clear();
  if(first.exists() || !Files.exists(login) || !Files.exists(book)) throw new AssertionError("cleanup");
  File old = storage.begin();
  Files.writeString(old.toPath().resolve("residue"), "crash");
  File next = new TemporaryVideoStorage(cache.toFile()).begin();
  if(old.exists() || !next.isDirectory()) throw new AssertionError("recovery");
  storage.clear();
  Files.createSymbolicLink(cache.resolve("cebola-streaming"), books);
  try { new TemporaryVideoStorage(cache.toFile()); throw new AssertionError("root symlink accepted"); }
  catch(IOException expected) {}
  if (!Files.exists(book)) throw new AssertionError("external deleted");
 }
}`);
    await exec(javaTool('javac'), ['-d', dir, source, harness]);
    await exec(javaTool('java'), ['-cp', dir, 'StorageTest', dir]);
    assert.ok(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
