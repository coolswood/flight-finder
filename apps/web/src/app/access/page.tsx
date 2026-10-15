import { AccessScreen } from './AccessScreen';
import { InvitationScreen } from './InvitationScreen';
import { sanitizeNext } from '@/lib/safe-next';
import { sharedAccessStore } from '@/lib/sidedoor/access/service';

export const dynamic = 'force-dynamic';

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ next?: string; mode?: string }> }) {
  const params = await searchParams;
  const next = sanitizeNext(params.next);
  const hosted = process.env.SELF_HOSTED !== 'true';
  if (hosted && params.mode === 'invite') return <InvitationScreen next={next ?? '/'} />;
  const mode = hosted ? (params.mode === 'recover' ? 'recover' : 'login') : 'household';
  const needsLocalSetup = !hosted && !(await sharedAccessStore.admissionPolicy()).hasOwner;
  return <AccessScreen next={next} mode={mode} hosted={hosted} needsLocalSetup={needsLocalSetup} />;
}
