import { validateAccessOrigins } from 'thesidedoor-core/access/http';

/** Use the shared validator for canonical URLs and password-only aliases. */
export function accessOrigin(value: string): string {
  const { canonicalOrigin } = validateAccessOrigins({ origin: value });
  if (new URL(canonicalOrigin).hostname.includes('*')) throw new Error('Wildcard access origins are not allowed');
  return canonicalOrigin;
}

export function accessOrigins(publicBaseUrl: string | null | undefined) {
  const origin = accessOrigin(publicBaseUrl || process.env.APP_URL || 'http://localhost:3003');
  const configured: unknown = process.env.SIDEDOOR_PASSWORD_ORIGINS === undefined
    ? [] : JSON.parse(process.env.SIDEDOOR_PASSWORD_ORIGINS);
  if (!Array.isArray(configured) || !configured.every((value): value is string => typeof value === 'string')) {
    throw new Error('SIDEDOOR_PASSWORD_ORIGINS must be a JSON array of explicit origins');
  }
  // The installer includes local addresses even when one is also the canonical URL.
  const passwordOrigins = [...new Set(configured.map(accessOrigin))].filter(value => value !== origin);
  return { origin, passwordOrigins };
}
