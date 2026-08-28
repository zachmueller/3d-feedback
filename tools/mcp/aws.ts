/**
 * Credentials and SigV4 signing, in this process.
 *
 * Publishing used to shell out to `aws configure export-credentials` and let curl
 * sign; both are gone. The SDK's node provider chain resolves the same profiles
 * the CLI does — env, `~/.aws/config`, `credential_process`, assumed roles, and
 * the SSO cache `aws sso login` writes — so nothing about how you authenticate
 * changed, only which process does it. What is gained: a missing binary can no
 * longer break a publish, and a credential failure arrives as an error object
 * instead of a line of someone else's stderr.
 *
 * No credential ever leaves this module. Callers pass a profile *name*.
 */
import { Sha256 } from '@aws-crypto/sha256-js';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

export type CredentialProvider = ReturnType<typeof fromNodeProviderChain>;

/**
 * Credentials could not be resolved, or are for the wrong place.
 *
 * `reason` and `fix` are kept apart from the joined message so check_setup can
 * render them as its own two lines rather than re-splitting a string.
 */
export class CredentialError extends Error {
  readonly reason: string;
  readonly fix: string;

  constructor(reason: string, fix: string) {
    super(`${reason}\n\nfix: ${fix}`);
    this.name = 'CredentialError';
    this.reason = reason;
    this.fix = fix;
  }
}

/** Memoized per profile: the chain reads config files and the SSO cache. */
const providers = new Map<string, CredentialProvider>();

export function credentialProvider(profile: string | null): CredentialProvider {
  const key = profile ?? '';
  let provider = providers.get(key);
  if (!provider) {
    provider = fromNodeProviderChain(profile ? { profile } : {});
    providers.set(key, provider);
  }
  return provider;
}

/** How the caller describes themselves in a message about credentials. */
export const whoIsSigning = (profile: string | null): string =>
  profile ? `profile ${profile}` : 'the default credential chain';

/**
 * What to do about a credential failure. An expired SSO session is by far the
 * most common one and has a one-line fix, so it is worth detecting rather than
 * telling everyone to check their configuration.
 */
export function credentialFix(err: unknown, profile: string | null): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/expired|sso[-_ ]?session|invalid_grant|token/i.test(message)) {
    return `Run: aws sso login${profile ? ` --profile ${profile}` : ''}`;
  }
  if (/could not load credentials|profile .* could not be found|is not configured/i.test(message)) {
    return 'Set THREED_AWS_PROFILE to a profile with access to the deployment account.';
  }
  return 'Check the profile has live credentials for the deployment account.';
}

/**
 * Sign a request and return the headers to send with it.
 *
 * `execute-api` is the signing service for an HTTP API's IAM authorizer, which is
 * what guards POST /publish. Only the two endpoint URLs this server knows are ever
 * signed, and the signature covers the body, so a truncated upload of the JSON
 * would be rejected rather than half-applied.
 */
export async function signHeaders(input: {
  method: string;
  url: string;
  body: string;
  region: string;
  profile: string | null;
  headers?: Record<string, string>;
}): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const signer = new SignatureV4({
    service: 'execute-api',
    region: input.region,
    credentials: credentialProvider(input.profile),
    sha256: Sha256,
  });

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  try {
    const signed = await signer.sign(
      new HttpRequest({
        method: input.method,
        protocol: url.protocol,
        hostname: url.hostname,
        ...(url.port ? { port: Number(url.port) } : {}),
        path: url.pathname,
        query,
        // `host` has to be signed, and fetch sets it itself, so it must match.
        headers: { ...input.headers, host: url.host },
        body: input.body,
      }),
    );
    return signed.headers as Record<string, string>;
  } catch (err) {
    throw new CredentialError(
      `Could not sign the request with ${whoIsSigning(input.profile)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      credentialFix(err, input.profile),
    );
  }
}

export interface CallerIdentity {
  account: string;
  arn: string;
}

/**
 * Who the configured profile is. Worth asking before anything else, because
 * credentials that are live but for the wrong account produce an opaque 403 from
 * the IAM authorizer that says nothing about profiles.
 */
export async function callerIdentity(
  profile: string | null,
  region: string,
): Promise<CallerIdentity> {
  const client = new STSClient({ region, credentials: credentialProvider(profile) });
  try {
    const res = await client.send(new GetCallerIdentityCommand({}));
    return { account: String(res.Account ?? ''), arn: String(res.Arn ?? '') };
  } catch (err) {
    throw new CredentialError(
      `${whoIsSigning(profile)}: ${err instanceof Error ? err.message : String(err)}`,
      credentialFix(err, profile),
    );
  } finally {
    client.destroy();
  }
}
