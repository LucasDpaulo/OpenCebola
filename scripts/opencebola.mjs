#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { setupConfig, readConfig, saveConfig, publicEnvironment, requireDatabase, nativeConfig } from './instance-config.mjs';

const root = new URL('../', import.meta.url);
const cwd = fileURLToPath(root);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const children = new Set();
const command = process.argv[2] ?? 'help';
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CEBOLA_|OPENCEBOLA_|SUPABASE_|NEXT_PUBLIC_)/.test(key)));
function run(binary, args, { env = {}, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { ...cleanEnvironment(), ...env }, stdio: capture ? ['ignore','pipe','pipe'] : 'inherit', shell: process.platform === 'win32' && /\.cmd$/.test(binary) });
    children.add(child);
    let output = '';
    if (capture) {
      child.stdout.on('data', value => { if (output.length < 2_000_000) output += value; });
      // CLI tools can print credentials to either stream. Do not forward them.
      child.stderr.on('data', () => {});
    }
    child.on('error', () => { children.delete(child); reject(new Error(`Não foi possível executar ${binary}. Confira os pré-requisitos.`)); });
    child.on('exit', code => {
      children.delete(child);
      code === 0 ? resolve(output) : reject(new Error(`${binary} ${args[0]} falhou (código ${code ?? 'sinal'}). Consulte docs/EXECUTAR.md; nenhuma credencial foi impressa pelo assistente.`));
    });
  });
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { for (const child of children) child.kill(signal); process.exit(signal === 'SIGINT' ? 130 : 143); });
async function exists(path) { try { await access(new URL(path, root)); return true; } catch { return false; } }
// Pin the major CLI interface; the local stack is independent of any linked remote project.
const supabase = (args) => run(npx, ['--yes','--package=supabase@2','supabase',...args], { capture: true });
async function databaseStart() {
  const config = await readConfig(root);
  if (config.SUPABASE_URL && !['localhost','127.0.0.1','[::1]'].includes(new URL(config.SUPABASE_URL).hostname)) {
    throw new Error('O .env aponta para um banco remoto. db:start não substitui essa configuração. Use outra cópia do projeto para testar localmente.');
  }
  await run('docker', ['info','--format','{{.ServerVersion}}'], { capture: true });
  console.log('Preparando banco e autenticação locais. O primeiro início pode baixar imagens Docker.');
  if (!await exists('supabase/config.toml')) {
    await supabase(['init']);
    const path = new URL('supabase/config.toml',root);
    const source = await readFile(path,'utf8');
    await writeFile(path,source.replace(/5432([0-9])/g,'5543$1'));
  }
  await mkdir(new URL('supabase/migrations/',root), { recursive: true });
  for (const name of (await readdir(new URL('infra/supabase/migrations/', root))).filter(name => name.endsWith('.sql'))) {
    await copyFile(new URL(`infra/supabase/migrations/${name}`,root), new URL(`supabase/migrations/${name}`,root));
  }
  await supabase(['start','--exclude','studio,imgproxy,inbucket,storage-api,realtime,edge-runtime,logflare,vector,supavisor']);
  await supabase(['migration','up','--local']);
  const status = parseEnv(await supabase(['status','-o','env']));
  const url = status.API_URL;
  const publishable = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
  const service = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  if (!url || !publishable || !service) throw new Error('A CLI não retornou as credenciais esperadas. Consulte docs/EXECUTAR.md.');
  await saveConfig(root, { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: publishable, SUPABASE_SERVICE_ROLE_KEY: service });
  console.log('Banco local iniciado; credenciais salvas somente no .env privado. Próximo: npm run user:add');
}
async function addUser() {
  const config = await readConfig(root); requireDatabase(config);
  if (!process.stdin.isTTY) throw new Error('Execute user:add em um terminal interativo; a senha não deve entrar nos argumentos ou logs.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  let email, password, repeated;
  try {
    email = (await rl.question('E-mail para acessar a SUA instância: ')).trim();
    process.stdout.write('Senha nova (mínimo 12 caracteres; entrada oculta): '); muted = true;
    password = await rl.question('');
    process.stdout.write('\nRepita a senha: '); repeated = await rl.question('');
  } finally { rl.close(); muted = false; process.stdout.write('\n'); }
  if (!email.includes('@') || password.length < 12 || password !== repeated) throw new Error('E-mail inválido ou senhas diferentes/curtas; usuário não criado.');
  const url = new URL('/auth/v1/admin/users', config.SUPABASE_URL);
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { apikey: config.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  if (!response.ok) throw new Error(`Não foi possível criar o usuário no seu banco (HTTP ${response.status}). Verifique se o e-mail já existe e se o banco está disponível.`);
  console.log('Usuário criado apenas no banco configurado. Sua conta Stremio será conectada pela interface.');
}
async function configureNative() {
  const config = await readConfig(root);
  const instance = nativeConfig(config);
  await writeFile(new URL('apps/tizen/www/instance.js', root), `window.OPENCEBOLA_INSTANCE = ${JSON.stringify(instance)};\n`);
  await writeFile(new URL('apps/roku/telas/components/InstanceConfig.brs', root), `function openCebolaApiUrl() as String\n  return "${instance.apiUrl}"\nend function\n`);
  console.log('Tizen e Roku configurados com os endereços públicos da sua instância. Nenhum segredo foi incluído.');
  return { config, instance };
}
async function buildWeb(config) {
  await run(npm, ['run','build','--workspace=@cebola/contracts']);
  await run(npm, ['run','build','--workspace=@cebola/web'], { env: publicEnvironment(config) });
}
try {
  switch (command) {
    case 'setup':
      console.log(await setupConfig(root) ? '.env privado criado com chaves novas. Próximo: npm ci e npm run db:start.' : '.env já existe; configurações e chaves preservadas.');
      break;
    case 'doctor': {
      let failures = 0;
      const version = process.versions.node.split('.').map(Number);
      console.log(`Node ${process.versions.node}: ${version[0] > 22 || (version[0] === 22 && version[1] >= 13) ? 'OK' : 'requer 22.13+'}`);
      if (version[0] < 22 || (version[0] === 22 && version[1] < 13)) failures++;
      for (const [binary,args,label] of [[npm,['--version'],'npm'],['docker',['info','--format','{{.ServerVersion}}'],'Docker (banco local)']]) {
        try { await run(binary,args,{capture:true}); console.log(`${label}: OK`); }
        catch { console.log(`${label}: indisponível`); failures++; }
      }
      try { const config = await readConfig(root); requireDatabase(config); publicEnvironment(config); console.log('Configuração da instância: completa (segredos ocultos)'); }
      catch (error) { console.log(error.message); failures++; }
      console.log('Android/iOS/Tizen/desktop exigem seus respectivos SDKs. Veja docs/PLATAFORMAS.md.');
      process.exitCode = failures ? 1 : 0;
      break;
    }
    case 'db:start': await databaseStart(); break;
    case 'db:stop': await supabase(['stop']); console.log('Serviços locais parados; volumes preservados.'); break;
    case 'user:add': await addUser(); break;
    case 'dev': {
      const config = await readConfig(root); requireDatabase(config);
      await run(npm,['run','build','--workspace=@cebola/contracts']);
      console.log('OpenCebola: http://localhost:3000 — Ctrl+C para encerrar.');
      try {
        await Promise.all([
          run(npm,['run','dev','--workspace=@cebola/api'], { env: config }),
          run(npm,['run','dev','--workspace=@cebola/web','--','--hostname','localhost'], { env: publicEnvironment(config) })
        ]);
      } finally { for (const child of children) child.kill('SIGTERM'); }
      break;
    }
    case 'build': {
      const config = await readConfig(root);
      await run(npm,['run','build','--workspace=@cebola/contracts']);
      await run(npm,['run','build','--workspace=@cebola/api']);
      await run(npm,['run','build','--workspace=@cebola/web'], { env: publicEnvironment(config) });
      break;
    }
    case 'build:web': await buildWeb(await readConfig(root)); break;
    case 'native:configure': await configureNative(); break;
    case 'package:android': {
      const config = await readConfig(root); nativeConfig(config);
      await run(npm,['run','apk','--workspace=@cebola/app']);
      console.log('APK de desenvolvimento em apps/app/android/app/build/outputs/apk/debug. Motor torrent local exige o build dedicado descrito na documentação.');
      break;
    }
    case 'package:ios': {
      if (process.platform !== 'darwin') throw new Error('iOS exige macOS e Xcode.');
      const config = await readConfig(root); nativeConfig(config);
      await run(npm,['run','sync:ios','--workspace=@cebola/app']);
      console.log('Abra apps/app/ios/App/App.xcodeproj no Xcode, configure sua assinatura e compile no aparelho.');
      break;
    }
    case 'package:linux': {
      if (process.platform !== 'linux') throw new Error('O empacotamento Linux exige um ambiente Linux.');
      await run('bash',['scripts/linux-build-streaming.sh',fileURLToPath(new URL('dist/linux/',root))]);
      break;
    }
    case 'package:windows': {
      if (process.platform !== 'win32') throw new Error('Use Windows com os SDKs e bibliotecas descritos em docs/PLATAFORMAS.md.');
      await run(npm,['run','tauri','--workspace=@cebola/pc','--','build','--config','src-tauri/tauri.windows.conf.json']);
      break;
    }
    case 'package:tizen': {
      const { config } = await configureNative();
      await run('bash',['scripts/tizen-empacotar-wgt.sh'], { env: config });
      break;
    }
    case 'package:roku': {
      const { config, instance } = await configureNative();
      const telasUrl = config.CEBOLA_ROKU_TELAS_URL ?? `${instance.webOrigin}/downloads/cebola-roku-telas.zip`;
      const url = new URL(telasUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.zip')) throw new Error('CEBOLA_ROKU_TELAS_URL deve ser uma URL HTTPS pública de ZIP, sem credenciais.');
      const env = { CEBOLA_ROKU_BUILD_VERSION: config.CEBOLA_ROKU_BUILD_VERSION ?? '1', CEBOLA_ROKU_TELAS_URL: telasUrl };
      await run('bash',['scripts/roku-empacotar-telas.sh'],{env});
      await run('bash',['scripts/roku-empacotar.sh'],{env});
      console.log('Pacotes em apps/roku/dist. Instale a casca por sideload; sirva o ZIP de telas na URL configurada.');
      break;
    }
    default:
      console.log('OpenCebola\nComandos: setup, doctor, db:start, db:stop, user:add, dev, build, build:web, native:configure, package:roku');
      if (command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
