/**
 * Cognito PreSignUp trigger — email allowlist.
 *
 * Fires for both native sign-ups (`PreSignUp_SignUp`) and federated/Google
 * just-in-time provisioning (`PreSignUp_ExternalProvider`). Throwing here
 * blocks user creation, so any Google account whose email is not on the
 * allowlist is rejected mid-flow.
 *
 * This is the first of two allowlist gates; the API handler re-checks the
 * caller's email on every admin request (defense in depth, and it catches users
 * created before an allowlist change).
 */
import type { PreSignUpTriggerEvent, PreSignUpTriggerHandler } from 'aws-lambda';

function allowlist(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
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
