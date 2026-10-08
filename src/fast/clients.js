import { askChatJudge } from './chat-judge-client.js';
import { askGatewayDecision } from './gateway-decision-client.js';
import { askJev } from './jev-client.js';

/**
 * TypeSafe answers System One questions natively, gateway decision models through
 * the decision API, and any other model through a JSON-mode chat completion.
 */
export function fastClientFor(fast) {
  if (fast.provider === 'typesafe') return askJev;
  return fast.decision ? askGatewayDecision : askChatJudge;
}
