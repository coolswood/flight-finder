import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Optional --baseline=<image-id> --baseline-ref=<full-commit> reproduces the
// original 403 with that revision's installer before upgrading the same database.
const root = fileURLToPath(new URL('../..', import.meta.url));
const image = process.argv[2];
const options = process.argv.slice(3);
const desktop = options.includes('--desktop');
const update = options.includes('--update');
const legacyInstaller = options.find(value => value.startsWith('--legacy-installer='))?.slice('--legacy-installer='.length);
const baselineImage = legacyInstaller ? image : options.find(value => value.startsWith('--baseline='))?.slice('--baseline='.length);
const baselineRef = legacyInstaller ?? options.find(value => value.startsWith('--baseline-ref='))?.slice('--baseline-ref='.length);
assert.ok(options.every(value => ['--desktop', '--update'].includes(value) || value.startsWith('--baseline=') || value.startsWith('--baseline-ref=') || value.startsWith('--legacy-installer=')), 'Unsupported option');
assert.ok(!update || baselineImage, 'Updater regression requires the historical installer and image');
assert.equal(Boolean(baselineImage), Boolean(baselineRef), 'Baseline image and source revision must be supplied together');
if (baselineImage) assert.match(baselineImage, /^sha256:[a-f0-9]{64}$/);
if (baselineRef) assert.match(baselineRef, /^[a-f0-9]{40}$/);
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'Pass the immutable local image ID built from the current checkout');
const directory = await mkdtemp(join(tmpdir(), 'flight-finder-installer-'));
const home = join(directory, 'home');
const install = join(home, '.flight-finder');
const project = `ff-installer-${process.pid}-${Date.now()}`;
const base = join(install, 'docker-compose.yml');
let override = join(directory, 'test-compose.yml');
const password = 'installer-browser-test-password';
const owner = 'installer-owner';
await mkdir(home);
const artifacts = process.env.INSTALLER_BROWSER_ARTIFACTS;
if (artifacts) await mkdir(artifacts, { recursive: true });

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  return server.address().port;
}
const reservation = createServer();
const port = await listen(reservation);
await new Promise(resolve => reservation.close(resolve));

const environment = {
  ...process.env, HOME: home, FLIGHT_FINDER_DIR: install, HOST_PORT: String(port),
  DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), '.docker'),
  FLIGHT_FINDER_YES: '1', FLIGHT_FINDER_OPEN_BROWSER: '0', FLIGHT_FINDER_SKIP_BUILD: '1',
  FLIGHT_FINDER_CLI_SOURCE: join(root, 'apps/web/public/flight-finder-cli'),
  COMPOSE_PROJECT_NAME: project, COMPOSE_FILE: [base, override].join(delimiter),
  TEST_ACCESS_NAME: owner, TEST_ACCESS_PASSWORD: password,
};
// The installer, not the test environment, must configure authentication.
for (const key of ['APP_URL', 'SIDEDOOR_PASSWORD_ORIGINS', 'FLIGHT_FINDER_BIND_ADDRESS', 'FLIGHT_FINDER_SKIP_START', 'FLIGHT_FINDER_EXTRA_ENV']) delete environment[key];
if (desktop) environment.FLIGHT_FINDER_BIND_ADDRESS = '127.0.0.1';

function command(executable, args, { allowFailure = false, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: { ...environment, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stdout = '';
    child.stdout.on('data', value => { output += value; stdout += value; });
    child.stderr.on('data', value => { output += value; });
    const timeout = setTimeout(() => { process.kill(-child.pid, 'SIGKILL'); }, 240_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0 && !allowFailure) reject(new Error(`${executable} ${args.join(' ')} exited ${code}\n${output}`));
      else resolve({ code, output, stdout });
    });
  });
}
const compose = (...args) => command('docker', ['compose', '-p', project, '-f', base, '-f', override, ...args]);
const installer = options => command('bash', ['apps/web/public/install.sh', '--no-browser'], options);
const access = (...args) => compose('run', '--rm', '--no-deps', '--entrypoint', 'node', 'web', '/app/packages/cli/dist/index.js', 'access', ...args);

// Only isolate resources and select the image. Never supply APP_URL or origin aliases here.
async function selectImage(selectedImage) {
  await writeFile(override, `services:
  db:
    ports: !reset []
  redis:
    ports: !reset []
  web:
    image: ${selectedImage}
    build: !reset null
    environment:
      INSTALL_CLI_PROVIDERS: "false"
      CRON_ENABLED: "false"
`);
}
await selectImage(image);

let browser;
let proxy;
let rejectedHost;
let assetsServer;
async function runUpdate() {
  return command('bash', [join(home, '.local/bin/flight-finder'), 'update']);
}
try {
  browser = await chromium.launch({ args: ['--no-proxy-server', '--host-resolver-rules=MAP finder.test 127.0.0.1, MAP unknown.test 127.0.0.1'] });
  let baselineSaved;
  let baselinePrincipals;
  if (baselineImage) {
    console.log(`Installing unfixed revision ${baselineRef} from ${baselineImage}`);
    const revision = (await command('docker', ['image', 'inspect', baselineImage, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}'])).output.trim();
    assert.match(revision, /^[a-f0-9]{7,40}$/);
    const resolvedRevision = (await command('git', ['rev-parse', '--verify', `${revision}^{commit}`])).output.trim();
    if (!legacyInstaller) assert.equal(resolvedRevision, baselineRef, 'Baseline image must identify the exact archived source revision');
    else console.log('CI fixture uses the current backend with the historical installer and updater');
    const assets = join(directory, 'baseline');
    await mkdir(assets);
    for (const name of ['install.sh', 'flight-finder-cli', 'flight-finder-cli-flags.sh']) {
      const source = await command('git', ['show', `${baselineRef}:apps/web/public/${name}`]);
      await writeFile(join(assets, name), source.output);
    }
    await selectImage(baselineImage);
    const installed = await command('bash', [join(assets, 'install.sh'), '--no-browser'], {
      env: { FLIGHT_FINDER_CLI_SOURCE: join(assets, 'flight-finder-cli') },
    });
    assert.match(installed.output, /Flight Finder is ready/);
    await command('python3', ['scripts/testing/access-setup.py', 'docker', 'compose', '-p', project, '-f', base, '-f', override,
      'run', '--rm', '--no-deps', '--entrypoint', 'node', 'web', '/app/packages/cli/dist/index.js', 'access', 'setup']);
    baselineSaved = await readFile(join(install, '.env'), 'utf8');
    baselinePrincipals = JSON.parse((await access('list')).stdout);
    assert.ok(baselinePrincipals.principals.some(principal => principal.name === owner && principal.role === 'owner'));
    await compose('up', '-d', '--wait', '--wait-timeout', '180', '--no-deps', '--force-recreate', 'web');
    const baselineLogs = (await compose('logs', '--no-color', 'web')).output;
    assert.match(baselineLogs, /"sourceUsers":1/);
    assert.match(baselineLogs, /"setupComplete":false/);
    const oldContext = await browser.newContext();
    try {
      const page = await oldContext.newPage();
      await page.goto(`http://localhost:${port}/access`);
      await page.locator('input[type=password]').fill(password);
      const response = page.waitForResponse(response => response.url().endsWith('/api/access/household') && response.request().method() === 'POST');
      await page.locator('button[type=submit]').click();
      assert.equal((await response).status(), 403, 'Unfixed installer must reproduce the reported rejection with an existing owner');
      if (legacyInstaller) await page.getByText(/This address is not configured for login/).waitFor();
      else await page.getByText('This action is not allowed.', { exact: true }).waitFor();
      assert.equal((await oldContext.cookies()).some(cookie => cookie.name === 'ft-session'), false);
      if (artifacts) await page.screenshot({ path: join(artifacts, 'before-login-rejected.png'), fullPage: true });
      console.log(`REPRODUCED ${baselineRef}: installer reports ready, owner exists, valid password returns 403 and the reported UI error`);
    } finally { await oldContext.close(); }
    await selectImage(image);
  }
  console.log(baselineImage ? 'Upgrading the reproduced broken installation' : 'Installing into an empty home and database');
  let initial;
  if (update) {
    const updaterOverride = join(install, 'docker-compose.override.yml');
    await writeFile(updaterOverride, await readFile(override));
    override = updaterOverride;
    environment.COMPOSE_FILE = [base, override].join(delimiter);
    assetsServer = httpServer(async (request, response) => {
      const paths = ['/flight-finder-cli', '/flight-finder-cli-flags.sh', '/install/network.sh', '/install/update.py'];
      if (!paths.includes(request.url)) { response.writeHead(404); response.end(); return; }
      response.end(await readFile(join(root, 'apps/web/public', request.url)));
    });
    environment.FLIGHT_FINDER_URL = `http://127.0.0.1:${await listen(assetsServer)}`;
    const binaries = join(directory, 'bin');
    await mkdir(binaries);
    const dockerPath = (await command('which', ['docker'])).stdout.trim();
    // The candidate is an immutable local image, with no remote registry tag.
    // Only registry pulling is replaced. Every Compose operation uses real Docker.
    await writeFile(join(binaries, 'docker'), `#!/usr/bin/env bash\nfor arg in "$@"; do\n  if [ "$arg" = pull ]; then exit 0; fi\ndone\nexec ${JSON.stringify(dockerPath)} "$@"\n`, { mode: 0o755 });
    environment.PATH = `${binaries}:${join(home, '.local/bin')}:${environment.PATH}`;
    await runUpdate();
    assert.equal(await readFile(join(install, '.env'), 'utf8'), baselineSaved, 'Historical invocation must only bootstrap migration support');
    await compose('up', '-d', '--wait', '--wait-timeout', '180', '--no-deps', 'web');
    const rejected = await fetch(`http://127.0.0.1:${port}/api/access/check-origin`, {
      method: 'POST', headers: { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(rejected.status, 403, 'First historical invocation must demonstrate that origin repair has not run yet');
    console.log('PASS historical first invocation refreshes CLI but still reproduces the rejected origin');
    initial = await runUpdate();
    assert.match(initial.output, /Updated and verified/);
  } else initial = await installer();
  if (baselineImage) {
    const upgraded = await readFile(join(install, '.env'), 'utf8');
    if (update) assert.ok(upgraded.startsWith(baselineSaved), 'Updater changed existing configuration bytes');
    else assert.equal(upgraded, baselineSaved, 'Upgrade changed existing credentials or configuration');
    assert.deepEqual(JSON.parse((await access('list')).stdout), baselinePrincipals, 'Upgrade changed existing principals');
    console.log('PASS upgrade preserves the existing owner, credentials and configuration');
  } else {
    assert.match(initial.output, /Local password setup is required/);
    assert.doesNotMatch(initial.output, /Flight Finder is ready/);
    const setupContext = await browser.newContext();
    try {
      const page = await setupContext.newPage();
      await page.goto(`http://localhost:${port}/access`);
      await page.getByText('flight-finder access setup', { exact: true }).waitFor();
      assert.equal(await page.locator('input[type=password]').count(), 0, 'Do not show a login form before local setup');
      console.log(`PASS ${desktop ? 'desktop' : 'unattended'} first-run handoff to local password setup`);
    } finally { await setupContext.close(); }
    await command('python3', ['scripts/testing/access-setup.py', 'docker', 'compose', '-p', project, '-f', base, '-f', override,
      'run', '--rm', '--no-deps', '--entrypoint', 'node', 'web', '/app/packages/cli/dist/index.js', 'access', 'setup']);
    await installer();
  }
  const config = JSON.parse((await compose('config', '--format', 'json')).output);
  const canonical = config.services.web.environment.APP_URL;
  const aliases = JSON.parse(config.services.web.environment.SIDEDOOR_PASSWORD_ORIGINS);
  assert.equal(canonical, `http://localhost:${port}`);
  assert.ok(aliases.includes(`http://127.0.0.1:${port}`));
  const lan = aliases.find(value => !/localhost|127\.0\.0\.1|\[::1\]/.test(value));
  if (desktop) assert.equal(lan, undefined, 'Desktop setup must not enroll LAN addresses');
  else assert.ok(lan, 'The all-interface install must detect a LAN address on this runner');
  const localAlias = lan ?? `http://127.0.0.1:${port}`;

  async function login(origin, secure = false) {
    const context = await browser.newContext({ ignoreHTTPSErrors: secure });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/access`);
      await page.locator('input[type=password]').fill(password);
      const response = page.waitForResponse(response => response.url() === `${origin}/api/access/household` && response.request().method() === 'POST');
      await page.locator('button[type=submit]').click();
      assert.equal((await response).status(), 200, `Browser login failed at ${origin}`);
      const cookies = await context.cookies(origin);
      const session = cookies.find(cookie => cookie.name === 'ft-session');
      assert.ok(session, `Browser did not retain the session at ${origin}`);
      assert.equal(session.secure, secure);
      assert.equal(session.httpOnly, true);
      // Follow the actual UI through profile selection into the first-run setup.
      const passkeyChoice = page.getByRole('button', { name: 'Continue without a passkey' });
      const nextStep = await Promise.race([
        passkeyChoice.waitFor().then(() => 'passkey'),
        page.waitForURL('**/login**').then(() => 'profile'),
      ]);
      if (nextStep === 'passkey') await passkeyChoice.click();
      await page.waitForURL('**/login**');
      await page.getByRole('button', { name: /installer-owner/ }).click();
      await page.waitForURL(url => ['/setup', '/admin'].includes(url.pathname));
      await page.reload();
      assert.ok(['/setup', '/admin'].includes(new URL(page.url()).pathname), 'Reload lost the authenticated Admin session');
      const state = await page.evaluate(async () => {
        const response = await fetch('/api/auth/me', { headers: { 'x-sidedoor-origin': location.origin } });
        return { status: response.status, body: await response.json() };
      });
      assert.equal(state.status, 200);
      assert.equal(state.body.data?.user?.username, 'installer-owner', 'Browser did not retain the selected profile');
      assert.equal(state.body.data?.user?.isAdmin, true, 'Browser did not reuse its authenticated Admin cookie');
      if (artifacts && origin === canonical) await page.screenshot({ path: join(artifacts, 'after-admin-session.png'), fullPage: true });
      console.log(`PASS browser login, profile selection and session reuse: ${origin}`);
    } finally { await context.close(); }
  }
  for (const origin of new Set([canonical, `http://127.0.0.1:${port}`, localAlias])) await login(origin);

  const saved = await readFile(join(install, '.env'), 'utf8');
  if (update) await runUpdate();
  else await installer();
  assert.equal(await readFile(join(install, '.env'), 'utf8'), saved, 'Reinstall changed existing configuration');
  assert.equal(JSON.parse((await compose('config', '--format', 'json')).output).services.web.environment.APP_URL, canonical);
  await login(canonical);
  console.log(`PASS ${update ? 'repeat update' : 'reinstall'} preserves port, credentials and configuration`);

  function forward(request, response) {
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path: request.url, method: request.method,
      headers: { ...request.headers, host: 'web:3003' } }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('error', error => { response.writeHead(502); response.end(error.message); });
    request.pipe(upstream);
  }
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=finder.test',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')]);
  proxy = httpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, forward);
  const publicOrigin = `https://finder.test:${await listen(proxy)}`;
  await access('origin', publicOrigin);
  await login(publicOrigin, true);
  await login(localAlias);
  console.log('PASS local origin recovery and mixed HTTPS/HTTP cookie policies');
  const invalid = await command('docker', ['compose', '-p', project, '-f', base, '-f', override,
    'run', '--rm', '--no-deps', '--entrypoint', 'node', 'web', '/app/packages/cli/dist/index.js', 'access', 'origin', 'https://finder.test/path'], { allowFailure: true });
  assert.notEqual(invalid.code, 0);
  await login(publicOrigin, true);
  console.log('PASS invalid recovery URL leaves the working configuration intact');

  rejectedHost = httpServer(forward);
  const unknownOrigin = `http://unknown.test:${await listen(rejectedHost)}`;
  const deniedContext = await browser.newContext();
  try {
    const page = await deniedContext.newPage();
    await page.goto(`${unknownOrigin}/access`);
    await page.locator('input[type=password]').fill(password);
    await page.locator('button[type=submit]').click();
    await page.getByText(/This address is not configured for login/).waitFor();
    assert.equal((await deniedContext.cookies()).some(cookie => cookie.name === 'ft-session'), false);
    console.log('PASS unknown address remains blocked with actionable UI error');
  } finally { await deniedContext.close(); }

  await writeFile(join(install, '.env'), saved + '\nSIDEDOOR_PASSWORD_ORIGINS=[]\n');
  const restricted = update ? await runUpdate() : await installer({ allowFailure: true });
  if (update) assert.match(restricted.output, /Updated and verified/);
  else {
    assert.notEqual(restricted.code, 0);
    assert.match(restricted.output, /Local access is not allowed/);
    assert.doesNotMatch(restricted.output, /Flight Finder is ready/);
  }
  assert.equal(await readFile(join(install, '.env'), 'utf8'), saved + '\nSIDEDOOR_PASSWORD_ORIGINS=[]\n');
  await login(publicOrigin, true);
  console.log(`PASS explicit origin restrictions survive ${update ? 'update' : 'reinstall'} and prevent false readiness`);
} catch (error) {
  console.error(error);
  console.error((await compose('logs', '--no-color', '--tail', '150')).output);
  process.exitCode = 1;
} finally {
  await browser?.close();
  proxy?.closeAllConnections();
  rejectedHost?.closeAllConnections();
  assetsServer?.closeAllConnections();
  if (assetsServer) await new Promise(resolve => assetsServer.close(resolve));
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  if (rejectedHost) await new Promise(resolve => rejectedHost.close(resolve));
  await compose('down', '-v', '--remove-orphans');
  await rm(directory, { recursive: true });
}
