import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const SRC = pathToFileURL('/app/apps/web/src/').href;

function rewrite(specifier, parentURL) {
  let url;
  if (specifier.startsWith('@/')) url = new URL(specifier.slice(2), SRC).href;
  else if (specifier.startsWith('./') || specifier.startsWith('../')) url = new URL(specifier, parentURL).href;
  else return null;
  if (/(^|\/)travel\/execution(\.ts)?$/.test(url)) return pathToFileURL('/tmp/ff-trace/execution-stub.mjs').href;
  if (existsSync(fileURLToPath(url))) return url;
  if (existsSync(fileURLToPath(url) + '.ts')) return url + '.ts';
  if (existsSync(fileURLToPath(url) + '/index.ts')) return url + '/index.ts';
  return url;
}

export async function resolve(specifier, context, next) {
  const parentURL = context.parentURL ?? undefined;
  if (parentURL?.startsWith(SRC) || specifier.startsWith('@/')) {
    const rewritten = rewrite(specifier, parentURL);
    if (rewritten) return next(rewritten, context);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.ts')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const code = stripTypeScriptTypes(source, { mode: 'strip' });
    return { format: 'module', shortCircuit: true, source: code };
  }
  return next(url, context);
}
