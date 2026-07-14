import type { ClientMessage } from "./types";

// Singleton bridge so components (e.g. AlertControl) can send client messages
// over the single WebSocket that useMarketData owns.
let _send: ((msg: ClientMessage) => void) | null = null;

export const wsSender = {
  register(send: (msg: ClientMessage) => void) {
    _send = send;
  },
  send(msg: ClientMessage) {
    _send?.(msg);
  },
};
