/**
 * Cognito PreSignUp trigger — email allowlist.
 *
 * Fires for both native sign-ups (`PreSignUp_SignUp`) and federated/Google
 * just-in-time provisioning (`PreSignUp_ExternalProvider`). Throwing here
 * blocks user creation, so any Google account whose email is on neither
 * allowlist is rejected mid-flow.
 *
 * **Two lists, one gate.** This trigger answers "may this person have an account
 * at all?", so it accepts an address on either `ALLOWED_EMAILS` (admin) or
 * `VIEWER_EMAILS` (read-only). What that account can then *do* is decided
 * per-request by the API handler, which checks the two lists separately — a
 * read-only user holds a perfectly valid pool token, so the handler's check is
 * the only thing standing between it and `/delete`.
 *
 * That per-request re-check is also defense in depth, and it catches users
 * created before an allowlist change.
 */
import type { PreSignUpTriggerEvent, PreSignUpTriggerHandler } from 'aws-lambda';

function emails(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/** Everyone who may have an account, of either role. */
function allowlist(): string[] {
  return [...emails(process.env.ALLOWED_EMAILS), ...emails(process.env.VIEWER_EMAILS)];
}

export const handler: PreSignUpTriggerHandler = async (
  event: PreSignUpTriggerEvent,
) => {
  const email = (event.request.userAttributes?.email ?? '').trim().toLowerCase();
  const allowed = allowlist();

  if (!email || !allowed.includes(email)) {
    // The thrown message surfaces to the Hosted UI as a sign-in error.
    throw new Error('This account is not authorized to access this application.');
  }

  // Federated users come pre-verified by Google; mark them confirmed so they
  // don't get stuck in an unconfirmed state.
  if (event.triggerSource === 'PreSignUp_ExternalProvider') {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  }

  return event;
};
