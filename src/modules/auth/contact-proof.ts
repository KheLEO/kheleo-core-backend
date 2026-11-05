import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { isUUID } from 'class-validator';

interface ContactInput {
  readonly email?: string;
  readonly phone?: string;
  readonly identityAccessToken?: string;
}
export interface ContactProof {
  readonly subject: string;
  readonly email?: string;
  readonly phone?: string;
}
export async function verifyContactProof(
  config: ConfigService,
  input: ContactInput,
  fetcher: typeof fetch = fetch,
): Promise<ContactProof | undefined> {
  const production = config.get<string>('app.nodeEnv', 'development') === 'production';
  if (!input.identityAccessToken && !production) return undefined;
  if (!input.identityAccessToken)
    throw new UnauthorizedException(
      'A Supabase identityAccessToken proving contact ownership is required',
    );
  const base = config.get<string>('auth.supabaseUrl');
  const key = config.get<string>('auth.supabasePublishableKey');
  if (!base || !key)
    throw new ServiceUnavailableException('Production contact verification is not configured');
  let response: Response;
  try {
    response = await fetcher(`${base.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${input.identityAccessToken}`, apikey: key },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
  } catch {
    throw new ServiceUnavailableException('Contact verification provider is unavailable');
  }
  if (response.status >= 500 || response.status === 429)
    throw new ServiceUnavailableException('Contact verification provider is unavailable');
  if (!response.ok) throw new UnauthorizedException('Invalid or expired contact proof');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ServiceUnavailableException('Contact verification provider returned invalid JSON');
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('id' in body) ||
    typeof body.id !== 'string' ||
    !isUUID(body.id)
  )
    throw new UnauthorizedException('Malformed contact proof');
  const record = body as Readonly<Record<string, unknown>>;
  if (
    input.email &&
    (record.email !== input.email ||
      typeof record.email_confirmed_at !== 'string' ||
      !Number.isFinite(Date.parse(String(record.email_confirmed_at))))
  )
    throw new UnauthorizedException('Confirmed email does not match contact proof');
  if (
    input.phone &&
    (String(record.phone).replace(/^\+/, '') !== input.phone.replace(/^\+/, '') ||
      typeof record.phone_confirmed_at !== 'string' ||
      !Number.isFinite(Date.parse(String(record.phone_confirmed_at))))
  )
    throw new UnauthorizedException('Confirmed phone does not match contact proof');
  if (!input.email && !input.phone)
    throw new UnauthorizedException('A confirmed contact is required');
  return {
    subject: body.id,
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
  };
}
