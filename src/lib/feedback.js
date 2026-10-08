// Ratings and suggestions reach the admin's email through a Formspree form (no
// backend needed). The form id is meant to be public in client code; it only lets
// someone send to that inbox. Web3Forms was tried first: its Cloudflare bot check
// answered extension requests with a challenge page instead of JSON.

export const FEEDBACK_FORM_ID = 'xdeagwgr';
const endpoint = () => `https://formspree.io/f/${FEEDBACK_FORM_ID}`;
const MAX_DISMISSALS = 3;

/** The form post. Only what the user typed, the rating and app details: no page content. */
export function feedbackPayload({ message, rating, email, version, language }) {
  return {
    _subject: `Browser Agent feedback${rating ? ` — ${rating}★` : ''}`,
    message: message || '(rating only)',
    rating: rating ?? null,
    email: email || '',
    extension_version: version,
    ui_language: language,
  };
}

export async function sendFeedback(fields) {
  if (!FEEDBACK_FORM_ID) throw new Error('Feedback is not set up yet.');
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(feedbackPayload(fields)),
  });
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  throw new Error(body.errors?.[0]?.message ?? body.error ?? `Feedback could not be sent (HTTP ${res.status}).`);
}

/** Asked after every finished task until the user rates once or closes it three times. */
export function shouldAskForRating(state = {}) {
  return !state.rated && (state.dismissals ?? 0) < MAX_DISMISSALS;
}

export function afterRating(state = {}) {
  return { ...state, rated: true };
}

export function afterDismissal(state = {}) {
  return { ...state, dismissals: (state.dismissals ?? 0) + 1 };
}
