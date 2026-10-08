import { askChatJudge } from './chat-judge-client.js';
import { askJev } from './jev-client.js';

/** TypeSafe answers System One questions natively; every other provider goes through a chat model. */
export function fastClientFor(provider) {
  return provider === 'typesafe' ? askJev : askChatJudge;
}
