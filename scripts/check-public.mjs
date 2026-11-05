#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ignored = new Set(['.git','node_modules','.next','out','dist','build','.build','.buildResult','.gradle','.native-build','target','supabase']);
const privateExtensions = /\.(?:pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db|dump|bak)$/i;
const generatedExtensions = /\.(?:apk|aab|wgt|zip|tsbuildinfo|log)$/i;
export function checkText(text) {
  const problems = [];
  const checks = [
    ['chave privada', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['token GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['credencial AWS', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['JWT literal', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
    ['URL com senha', /https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@/],
    ['domínio de instância privada', /\b[a-z0-9-]+\.duckdns\.org\b/i],
    ['caminho pessoal absoluto', /(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)[a-zA-Z0-9_.-]+[\/\\]/]
  ];
  for (const [name, pattern] of checks) if (pattern.test(text)) problems.push(name);
  return problems;
}
export async function audit(directory, tracked = []) {
  const problems = [];
  const trackedSet = new Set(tracked);
  let exceptions = [];
  try { exceptions = JSON.parse(await readFile(path.join(directory,'scripts/public-audit-exceptions.json'),'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const isPrivateEnv = name => name.startsWith('.env') && !['.env.example','.env.hosted.example','.env.native.example'].includes(name);
  for (const filename of tracked) {
    const base = path.basename(filename);
    if (isPrivateEnv(base) || privateExtensions.test(base) || generatedExtensions.test(base) || filename.split('/').some(part => ['.aws','.remember','.worktrees','node_modules','.next','out','dist','target'].includes(part))) {
      problems.push(`${filename}: arquivo privado ou artefato não permitido no Git`);
    }
  }
  let files = 0;
  async function visit(relative = '') {
    for (const item of await readdir(path.join(directory,relative),{withFileTypes:true})) {
      const filename = path.posix.join(relative,item.name);
      if (ignored.has(item.name)) continue;
      if (isPrivateEnv(item.name) && !trackedSet.has(filename)) continue;
      if (generatedExtensions.test(item.name) && !trackedSet.has(filename)) continue;
      if (item.isSymbolicLink()) { problems.push(`${filename}: link simbólico não permitido`); continue; }
      if (item.isDirectory()) { await visit(filename); continue; }
      if (privateExtensions.test(item.name)) { problems.push(`${filename}: extensão privada`); continue; }
      const buffer = await readFile(path.join(directory,filename)); files++;
      if (buffer.includes(0)) continue; // Binary assets require explicit human selection.
      for (const problem of checkText(buffer.toString('utf8'))) {
        const digest = createHash('sha256').update(buffer).digest('hex');
        if (!exceptions.some(entry => entry.file === filename && entry.rule === problem && entry.sha256 === digest)) problems.push(`${filename}: ${problem}`);
      }
    }
  }
  await visit();
  return { files, problems };
}
async function main() {
  const directory = fileURLToPath(new URL('../',import.meta.url));
  let tracked = [];
  // Never inspect a parent repository: this project must have its own history.
  try {
    if ((await lstat(path.join(directory,'.git'))).isDirectory()) {
      tracked = execFileSync('git',['ls-files','-z'],{cwd:directory,encoding:'utf8'}).split('\0').filter(Boolean);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = await audit(directory,tracked);
  if (result.problems.length) {
    for (const finding of result.problems) console.error(finding);
    console.error(`REPROVADO: ${result.problems.length} ocorrência(s). Os valores sensíveis não são exibidos.`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${result.files} arquivos examinados; nenhum padrão bloqueado encontrado.`);
    console.log('Esta checagem não certifica ausência de segredos. Revise o diff, as imagens, licenças e artefatos antes de publicar.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Não foi possível concluir a auditoria pública.'); process.exitCode=1; });
}
