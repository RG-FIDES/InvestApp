import type { ClientMessage, ServerMessage } from "./types";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000";

/**
 * Open the live market-data WebSocket with auto-reconnect.
 * Returns a handle with `send` and `close`.
 */
export function connectMarketWS(
  onMessage: (msg: ServerMessage) => void,
  onStatus: (connected: boolean) => void
) {
  let socket: WebSocket | null = null;
  let closedByUser = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    socket = new WebSocket(`${WS_URL}/ws/live`);
    socket.onopen = () => onStatus(true);
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      onStatus(false);
      if (!closedByUser) retry = setTimeout(open, 1000);
    };
    socket.onerror = () => socket?.close();
  };

  open();

  return {
    send(msg: ClientMessage) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    },
    close() {
      closedByUser = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}
