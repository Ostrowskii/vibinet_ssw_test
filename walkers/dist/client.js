// src/config.ts
var REMOTE_WSS = "wss://game.vibistudiotest.site";
function has_window() {
  return typeof window !== "undefined" && typeof window.location !== "undefined";
}
function from_global_override() {
  if (!has_window())
    return;
  const global_any = window;
  if (typeof global_any.__VIBI_WS_URL__ === "string") {
    return global_any.__VIBI_WS_URL__;
  }
  return;
}
function normalize(value) {
  if (value.startsWith("wss://")) {
    return value;
  }
  if (value.startsWith("ws://")) {
    return `wss://${value.slice("ws://".length)}`;
  }
  return `wss://${value}`;
}
function from_query_param() {
  if (!has_window())
    return;
  try {
    const url = new URL(window.location.href);
    const value = url.searchParams.get("ws");
    if (value) {
      return normalize(value);
    }
  } catch {}
  return;
}
function detect_url() {
  const manual = from_global_override() ?? from_query_param();
  if (manual) {
    return manual;
  }
  return REMOTE_WSS;
}
var WS_URL = detect_url();

// src/client.ts
var time_sync = {
  clock_offset: Infinity,
  lowest_ping: Infinity,
  request_sent_at: 0,
  last_ping: Infinity
};
var ws = new WebSocket(WS_URL);
var room_watchers = new Map;
var is_synced = false;
var sync_listeners = [];
function now() {
  return Math.floor(Date.now());
}
function server_time() {
  if (!isFinite(time_sync.clock_offset)) {
    throw new Error("server_time() called before initial sync");
  }
  return Math.floor(now() + time_sync.clock_offset);
}
function ensure_open() {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not open");
  }
}
function send(obj) {
  ensure_open();
  ws.send(JSON.stringify(obj));
}
function register_handler(room, handler) {
  if (!handler) {
    return;
  }
  if (room_watchers.has(room)) {
    throw new Error(`Handler already registered for room: ${room}`);
  }
  room_watchers.set(room, handler);
}
ws.addEventListener("open", () => {
  console.log("[WS] Connected");
  time_sync.request_sent_at = now();
  ws.send(JSON.stringify({ $: "get_time" }));
  setInterval(() => {
    time_sync.request_sent_at = now();
    ws.send(JSON.stringify({ $: "get_time" }));
  }, 2000);
});
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.$) {
    case "info_time": {
      const t = now();
      const ping = t - time_sync.request_sent_at;
      time_sync.last_ping = ping;
      if (ping < time_sync.lowest_ping) {
        const local_avg = Math.floor((time_sync.request_sent_at + t) / 2);
        time_sync.clock_offset = msg.time - local_avg;
        time_sync.lowest_ping = ping;
      }
      if (!is_synced) {
        is_synced = true;
        for (const cb of sync_listeners) {
          cb();
        }
        sync_listeners.length = 0;
      }
      break;
    }
    case "info_post": {
      const handler = room_watchers.get(msg.room);
      if (handler) {
        handler(msg);
      }
      break;
    }
  }
});
function gen_name() {
  const alphabet = "_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
  const bytes = new Uint8Array(8);
  const can_crypto = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function";
  if (can_crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0;i < 8; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0;i < 8; i++) {
    out += alphabet[bytes[i] % 64];
  }
  return out;
}
function post(room, data) {
  const name = gen_name();
  send({ $: "post", room, time: server_time(), name, data });
  return name;
}
function load(room, from = 0, handler) {
  register_handler(room, handler);
  send({ $: "load", room, from });
}
function watch(room, handler) {
  register_handler(room, handler);
  send({ $: "watch", room });
}
function unwatch(room) {
  room_watchers.delete(room);
  send({ $: "unwatch", room });
}
function close() {
  ws.close();
}
function on_sync(callback) {
  if (is_synced) {
    callback();
    return;
  }
  sync_listeners.push(callback);
}
function ping() {
  return time_sync.last_ping;
}
export {
  watch,
  unwatch,
  server_time,
  send,
  post,
  ping,
  on_sync,
  load,
  gen_name,
  close
};
