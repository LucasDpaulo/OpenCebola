import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { newConfig, setupConfig, mergeConfig, publicEnvironment, nativeConfig } from '../instance-config.mjs';
import { audit, checkText } from '../check-public.mjs';

test('setup generates independent keys and never overwrites an existing environment', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'opencebola-test-'));
  const root = pathToFileURL(dir+'/');
  try {
    await writeFile(new URL('.env.example',root),'NODE_ENV=development\n');
    assert.equal(await setupConfig(root),true);
    const content = await readFile(new URL('.env',root),'utf8');
    const config = parseEnv(content);
    assert.equal(Buffer.from(config.CEBOLA_PIN_PEPPER_BASE64,'base64').length,32);
    assert.equal(Buffer.from(config.CEBOLA_STREMIO_VAULT_KEY_BASE64,'base64').length,32);
    assert.notEqual(config.CEBOLA_PIN_PEPPER_BASE64,config.CEBOLA_STREMIO_VAULT_KEY_BASE64);
    assert.equal(await setupConfig(root),false);
    assert.equal(await readFile(new URL('.env',root),'utf8'),content);
    assert.notEqual(newConfig(''),newConfig(''));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('only allowlisted public values reach a web build; URL credential injection is rejected', () => {
  const config = { SUPABASE_SERVICE_ROLE_KEY:'private-example', CEBOLA_REAL_DEBRID_TOKEN:'private-example', NEXT_PUBLIC_ACCIDENTAL_SECRET:'private-example' };
  assert.deepEqual(Object.keys(publicEnvironment(config)).sort(), ['NEXT_PUBLIC_CEBOLA_API_URL','NEXT_PUBLIC_OPENCEBOLA_WEB_URL']);
  assert.throws(() => publicEnvironment({ NEXT_PUBLIC_CEBOLA_API_URL:'https:'+'//user:password@example.org' }));
  assert.throws(() => publicEnvironment({ NEXT_PUBLIC_CEBOLA_API_URL:'https://example.org/?token=secret' }));
  assert.throws(() => nativeConfig({}));
  assert.throws(() => nativeConfig({NEXT_PUBLIC_CEBOLA_API_URL:'http://192.0.2.10',NEXT_PUBLIC_OPENCEBOLA_WEB_URL:'http://192.0.2.10'}));
});
test('configuration updates preserve vault keys and do not interpret replacement sequences', () => {
  const original='CEBOLA_PIN_PEPPER_BASE64=keep-this-key\nSUPABASE_PUBLISHABLE_KEY=old\n';
  const result=mergeConfig(original,{SUPABASE_PUBLISHABLE_KEY:'value-$&'});
  assert.equal(parseEnv(result).CEBOLA_PIN_PEPPER_BASE64,'keep-this-key');
  assert.equal(parseEnv(result).SUPABASE_PUBLISHABLE_KEY,'value-$&');
  assert.throws(()=>mergeConfig(original,{SUPABASE_URL:'https://example.org\nINJECTED=yes'}));
});
test('publication audit catches tracked env, private files, and symlinks without exposing secrets',async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'opencebola-audit-'));
  try {
    await writeFile(path.join(dir,'.env'),'PRIVATE_EXAMPLE=not-for-logs');
    await writeFile(path.join(dir,'signing.keystore'),'private');
    await symlink('/tmp',path.join(dir,'outside'));
    const result=await audit(dir,['.env','node_modules']);
    assert.ok(result.problems.some(s=>s.includes('.env')));
    assert.ok(result.problems.some(s=>s.includes('node_modules')));
    assert.ok(result.problems.some(s=>s.includes('signing.keystore')));
    assert.ok(result.problems.some(s=>s.includes('outside')));
    assert.ok(!JSON.stringify(result).includes('not-for-logs'));
    assert.ok(checkText('-----BEGIN '+'PRIVATE KEY-----').length);
    assert.ok(checkText('gh'+'p_'+'A'.repeat(36)).length);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('local database assistant keeps secrets out of output and never resets or links a remote database', { skip: process.platform === 'win32' }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir, copyFile, chmod } = await import('node:fs/promises');
  const run = promisify(execFile);
  const dir = await mkdtemp(path.join(tmpdir(),'opencebola-cli-'));
  const project = pathToFileURL(dir+'/');
  try {
    await mkdir(new URL('scripts/',project));
    await mkdir(new URL('bin/',project));
    await mkdir(new URL('infra/supabase/migrations/',project),{recursive:true});
    for (const name of ['opencebola.mjs','instance-config.mjs']) await copyFile(new URL('../'+name,import.meta.url),new URL('scripts/'+name,project));
    await writeFile(new URL('.env.example',project),'NODE_ENV=development\n');
    await writeFile(new URL('infra/supabase/migrations/0001_test.sql',project),'-- synthetic migration\n');
    const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.txt', args.join(' ')+'\\n');
if (args.includes('init')) {
  fs.mkdirSync('supabase',{recursive:true});
  fs.writeFileSync('supabase/config.toml','project_id = "opencebola"\\n[api]\\nport = 54321\\n');
}
if (args.includes('status')) console.log('API_URL="http://127.0.0.1:55431"\\nANON_KEY="synthetic-publishable-key"\\nSERVICE_ROLE_KEY="synthetic-service-secret"');
`;
    for (const binary of ['docker','npx']) {
      const file = new URL('bin/'+binary,project);
      await writeFile(file,fixture); await chmod(file,0o755);
    }
    const env = { ...process.env, PATH: path.join(dir,'bin')+path.delimiter+process.env.PATH };
    const script = path.join(dir,'scripts/opencebola.mjs');
    await run(process.execPath,[script,'setup'],{cwd:dir,env});
    const before = parseEnv(await readFile(new URL('.env',project),'utf8'));
    const result = await run(process.execPath,[script,'db:start'],{cwd:dir,env});
    assert.ok(!result.stdout.includes('synthetic-service-secret'));
    assert.ok(!result.stderr.includes('synthetic-service-secret'));
    const after = parseEnv(await readFile(new URL('.env',project),'utf8'));
    assert.equal(after.SUPABASE_SERVICE_ROLE_KEY,'synthetic-service-secret');
    assert.equal(after.CEBOLA_STREMIO_VAULT_KEY_BASE64,before.CEBOLA_STREMIO_VAULT_KEY_BASE64);
    const calls = await readFile(new URL('calls.txt',project),'utf8');
    assert.match(calls,/migration up --local/);
    assert.doesNotMatch(calls,/\b(reset|link|push)\b/);
    assert.match(await readFile(new URL('supabase/config.toml',project),'utf8'),/port = 55431/);
    await writeFile(new URL('.env',project),mergeConfig(await readFile(new URL('.env',project),'utf8'),{SUPABASE_URL:'https://database.example.org'}));
    await assert.rejects(run(process.execPath,[script,'db:start'],{cwd:dir,env}),/banco remoto/);
    assert.equal(await readFile(new URL('calls.txt',project),'utf8'),calls);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
