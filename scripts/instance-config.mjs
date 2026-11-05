import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { readFile, writeFile, chmod } from 'node:fs/promises';

export const privateKeys = ['CEBOLA_PIN_PEPPER_BASE64', 'CEBOLA_STREMIO_VAULT_KEY_BASE64'];
export function newConfig(example) {
  return `${example.trim()}\n${privateKeys.map(key => `${key}=${randomBytes(32).toString('base64')}`).join('\n')}\n`;
}
export async function readConfig(root) {
  try { return parseEnv(await readFile(new URL('.env', root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Execute npm run setup primeiro.'); throw error; }
}
export async function setupConfig(root) {
  const content = newConfig(await readFile(new URL('.env.example', root), 'utf8'));
  try { await writeFile(new URL('.env', root), content, { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}
export function mergeConfig(text, entries) {
  let result = text;
  for (const [key, value] of Object.entries(entries)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n"\\]/.test(value)) throw new Error('Configuração inválida.');
    const line = `${key}="${value}"`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    result = pattern.test(result) ? result.replace(pattern, () => line) : `${result.trimEnd()}\n${line}\n`;
  }
  return result;
}
export async function saveConfig(root, entries) {
  const target = new URL('.env', root);
  const content = mergeConfig(await readFile(target, 'utf8'), entries);
  await writeFile(target, content, { mode: 0o600 });
  await chmod(target, 0o600);
}
export function publicEnvironment(config) {
  return {
    NEXT_PUBLIC_CEBOLA_API_URL: origin(config.NEXT_PUBLIC_CEBOLA_API_URL ?? 'http://localhost:3001'),
    NEXT_PUBLIC_OPENCEBOLA_WEB_URL: origin(config.NEXT_PUBLIC_OPENCEBOLA_WEB_URL ?? 'http://localhost:3000')
  };
}
export function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('URL da instância inválida.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Informe uma origem http(s), sem credenciais, caminho ou parâmetros.');
  }
  if (url.hostname.endsWith('.invalid')) throw new Error('Substitua a URL de exemplo pelo endereço da sua instância.');
  return url.origin;
}
export function requireDatabase(config) {
  for (const key of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', ...privateKeys]) {
    if (!config[key]) throw new Error(`Falta ${key}. Execute npm run db:start ou configure seu próprio banco.`);
  }
}
export function nativeConfig(config) {
  const { NEXT_PUBLIC_CEBOLA_API_URL: apiUrl, NEXT_PUBLIC_OPENCEBOLA_WEB_URL: webOrigin } = publicEnvironment(config);
  for (const value of [apiUrl, webOrigin]) {
    const url = new URL(value);
    if (['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
      throw new Error('Para TVs/celulares, configure um endereço alcançável pelo aparelho; localhost aponta para o próprio aparelho.');
    }
    if (url.protocol !== 'https:') throw new Error('A configuração nativa exige HTTPS com certificado confiável pelos aparelhos.');
  }
  return { apiUrl, webOrigin };
}
