import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { createAccessFixture } from '@/test/access-fixture';

const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, unavailable: false }));
vi.mock('@/lib/prisma', () => ({ prisma: {
  extractionConfig: { findUnique: async () => {
    if (boundary.unavailable) throw new Error('Database unavailable');
    return { publicBaseUrl: 'https://finder.example' };
  } },
  sidedoorState: { findUnique: async () => ({ state: await boundary.fixture!.access.store.read() }) },
} }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const { FlightFinderAccessStore } = await import('@/lib/sidedoor/access/access-store');
  const fixture = createAccessFixture();
  boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, sharedAccessStore: new FlightFinderAccessStore(), SHARED_SESSION_COOKIE: 'ft-session' };
});

beforeEach(async () => {
  vi.stubEnv('SELF_HOSTED', 'true');
  vi.stubEnv('SIDEDOOR_PASSWORD_ORIGINS', '[]');
  await import('./middleware');
  boundary.unavailable = false;
  boundary.fixture!.reset();
  await boundary.fixture!.access.store.transact(state => { state.initializations.push('flight-finder-platform-v1'); });
});
afterEach(() => vi.unstubAllEnvs());

it('admits the configured HTTPS origin when a proxy rewrites Host', async () => {
  const { middleware } = await import('./middleware');
  const request = new NextRequest('http://web:3003/api/access/household', { method: 'POST', headers: {
    host: 'web:3003', origin: 'https://finder.example', 'x-sidedoor-origin': 'https://finder.example', 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, body: '{"password":"still-readable"}' });
  const response = await middleware(request);
  expect(response.status).toBe(200);
  expect(await request.json()).toEqual({ password: 'still-readable' });
});

it.each<Record<string, string>>([
  { origin: 'https://attacker.example' },
  { origin: 'https://finder.example', 'x-sidedoor-origin': 'https://attacker.example' },
  { origin: 'https://finder.example', 'sec-fetch-site': 'cross-site' },
])('blocks proxy origin inconsistencies %j', async headers => {
  const { middleware } = await import('./middleware');
  const response = await middleware(new NextRequest('http://web:3003/api/access/household', {
    method: 'POST', headers: { host: 'web:3003', ...headers },
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: 'origin_not_allowed' });
  expect(response.headers.has('set-cookie')).toBe(false);
});

it('fails closed when the configured proxy origin cannot be read', async () => {
  boundary.unavailable = true;
  const { middleware } = await import('./middleware');
  const response = await middleware(new NextRequest('http://web:3003/api/access/household', {
    method: 'POST', headers: { host: 'web:3003', origin: 'https://finder.example' },
  }));
  expect(response.status).toBe(503);
  expect(response.headers.has('set-cookie')).toBe(false);
});

async function submit(headers: Record<string, string>, method = 'POST') {
  const { middleware } = await import('./middleware');
  return middleware(new NextRequest('https://finder.example/api/queries', { method, headers }));
}

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects cross-origin %s before solo administrator access', async method => {
  const response = await submit({ origin: 'https://attacker.example', 'content-type': 'text/plain' }, method);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ ok: false });
});
it('rejects sandboxed null origins and cross-site requests without an origin', async () => {
  expect((await submit({ origin: 'null' })).status).toBe(403);
  expect((await submit({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
});
it('requires admission after accepting same-origin and nonbrowser request origins', async () => {
  expect((await submit({ origin: 'https://finder.example', 'sec-fetch-site': 'same-origin' })).status).toBe(401);
  expect((await submit({ 'content-type': 'application/json' })).status).toBe(401);
});
it('keeps read-only cross-origin requests behind household admission', async () => {
  expect((await submit({ origin: 'https://attacker.example' }, 'GET')).status).toBe(401);
});
it('allows HTTPS requests through a trusted proxy with an internal listening URL', async () => {
  const { middleware } = await import('./middleware');
  const response = await middleware(new NextRequest('http://0.0.0.0:3003/api/queries', { method: 'PATCH', headers: {
    host: 'finder.example', origin: 'https://finder.example', 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin',
  } }));
  expect(response.status).toBe(401);
});
it('does not authorize attacker origins using an untrusted forwarded host', async () => {
  expect((await submit({ host: 'finder.example', origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example' })).status).toBe(403);
});
