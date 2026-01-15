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

// src/vibi.ts
class Vibi {
  room;
  init;
  on_tick;
  on_post;
  smooth;
  tick_rate;
  tolerance;
  room_posts;
  local_posts;
  timeline;
  cache_enabled;
  snapshot_stride;
  snapshot_count;
  snapshots;
  snapshot_start_tick;
  dirty_from_tick;
  initial_time_value;
  initial_tick_value;
  official_time(post2) {
    if (post2.client_time <= post2.server_time - this.tolerance) {
      return post2.server_time - this.tolerance;
    } else {
      return post2.client_time;
    }
  }
  official_tick(post2) {
    return this.time_to_tick(this.official_time(post2));
  }
  get_bucket(tick) {
    let bucket = this.timeline.get(tick);
    if (!bucket) {
      bucket = { room: [], local: [] };
      this.timeline.set(tick, bucket);
    }
    return bucket;
  }
  insert_room_post(post2, tick) {
    const bucket = this.get_bucket(tick);
    const room = bucket.room;
    if (room.length === 0 || room[room.length - 1].index <= post2.index) {
      room.push(post2);
    } else {
      const insert_at = room.findIndex((p) => p.index > post2.index);
      if (insert_at === -1) {
        room.push(post2);
      } else {
        room.splice(insert_at, 0, post2);
      }
    }
  }
  remove_room_post(post2, tick) {
    const bucket = this.timeline.get(tick);
    if (!bucket) {
      return;
    }
    const index = bucket.room.indexOf(post2);
    if (index !== -1) {
      bucket.room.splice(index, 1);
    } else {
      const by_index = bucket.room.findIndex((p) => p.index === post2.index);
      if (by_index !== -1) {
        bucket.room.splice(by_index, 1);
      }
    }
    if (bucket.room.length === 0 && bucket.local.length === 0) {
      this.timeline.delete(tick);
    }
  }
  mark_dirty(tick) {
    if (!this.cache_enabled) {
      return;
    }
    if (this.snapshot_start_tick !== null && tick < this.snapshot_start_tick) {
      return;
    }
    if (this.dirty_from_tick === null || tick < this.dirty_from_tick) {
      this.dirty_from_tick = tick;
    }
  }
  advance_state(state, from_tick, to_tick) {
    let next = state;
    for (let tick = from_tick + 1;tick <= to_tick; tick++) {
      next = this.apply_tick(next, tick);
    }
    return next;
  }
  prune_before_tick(prune_tick) {
    if (!this.cache_enabled) {
      return;
    }
    for (const tick of this.timeline.keys()) {
      if (tick < prune_tick) {
        this.timeline.delete(tick);
      }
    }
    for (const [index, info] of this.room_posts.entries()) {
      if (info.tick < prune_tick) {
        this.room_posts.delete(index);
      }
    }
    for (const [name, info] of this.local_posts.entries()) {
      if (info.tick < prune_tick) {
        this.local_posts.delete(name);
      }
    }
  }
  ensure_snapshots(at_tick, initial_tick) {
    if (!this.cache_enabled) {
      return;
    }
    if (this.snapshot_start_tick === null) {
      this.snapshot_start_tick = initial_tick;
    }
    if (this.snapshot_start_tick === null) {
      return;
    }
    let start_tick = this.snapshot_start_tick;
    if (this.dirty_from_tick !== null) {
      const dirty = this.dirty_from_tick;
      if (dirty >= start_tick) {
        const keep_until_tick = dirty - 1;
        const keep_index = Math.floor((keep_until_tick - start_tick) / this.snapshot_stride);
        if (keep_index < 0) {
          this.snapshots.length = 0;
        } else if (keep_index < this.snapshots.length - 1) {
          this.snapshots.length = keep_index + 1;
        }
      }
      this.dirty_from_tick = null;
    }
    if (at_tick < start_tick) {
      return;
    }
    const target_index = Math.floor((at_tick - start_tick) / this.snapshot_stride);
    let state;
    let current_tick;
    if (this.snapshots.length === 0) {
      state = this.init;
      current_tick = start_tick - 1;
    } else {
      state = this.snapshots[this.snapshots.length - 1];
      current_tick = start_tick + (this.snapshots.length - 1) * this.snapshot_stride;
    }
    for (let idx = this.snapshots.length;idx <= target_index; idx++) {
      const next_tick = start_tick + idx * this.snapshot_stride;
      state = this.advance_state(state, current_tick, next_tick);
      this.snapshots.push(state);
      current_tick = next_tick;
    }
    if (this.snapshots.length > this.snapshot_count) {
      const overflow = this.snapshots.length - this.snapshot_count;
      this.snapshots.splice(0, overflow);
      start_tick += overflow * this.snapshot_stride;
    }
    this.snapshot_start_tick = start_tick;
    this.prune_before_tick(start_tick);
  }
  add_room_post(post2) {
    const tick = this.official_tick(post2);
    if (post2.index === 0 && this.initial_time_value === null) {
      const t = this.official_time(post2);
      this.initial_time_value = t;
      this.initial_tick_value = this.time_to_tick(t);
    }
    if (this.cache_enabled && this.snapshot_start_tick !== null && tick < this.snapshot_start_tick) {
      return;
    }
    const existing = this.room_posts.get(post2.index);
    if (existing) {
      this.remove_room_post(existing.post, existing.tick);
      this.room_posts.set(post2.index, { post: post2, tick });
      this.insert_room_post(post2, tick);
      this.mark_dirty(Math.min(existing.tick, tick));
      return;
    }
    this.room_posts.set(post2.index, { post: post2, tick });
    this.insert_room_post(post2, tick);
    this.mark_dirty(tick);
  }
  add_local_post(name, post2) {
    if (this.local_posts.has(name)) {
      this.remove_local_post(name);
    }
    const tick = this.official_tick(post2);
    if (this.cache_enabled && this.snapshot_start_tick !== null && tick < this.snapshot_start_tick) {
      return;
    }
    this.local_posts.set(name, { post: post2, tick });
    this.get_bucket(tick).local.push(post2);
    this.mark_dirty(tick);
  }
  remove_local_post(name) {
    const info = this.local_posts.get(name);
    if (!info) {
      return;
    }
    this.local_posts.delete(name);
    const bucket = this.timeline.get(info.tick);
    if (bucket) {
      const index = bucket.local.indexOf(info.post);
      if (index !== -1) {
        bucket.local.splice(index, 1);
      } else {
        const by_name = bucket.local.findIndex((p) => p.name === name);
        if (by_name !== -1) {
          bucket.local.splice(by_name, 1);
        }
      }
      if (bucket.room.length === 0 && bucket.local.length === 0) {
        this.timeline.delete(info.tick);
      }
    }
    this.mark_dirty(info.tick);
  }
  apply_tick(state, tick) {
    let next = this.on_tick(state);
    const bucket = this.timeline.get(tick);
    if (bucket) {
      for (const post2 of bucket.room) {
        next = this.on_post(post2.data, next);
      }
      for (const post2 of bucket.local) {
        next = this.on_post(post2.data, next);
      }
    }
    return next;
  }
  compute_state_at_uncached(initial_tick, at_tick) {
    let state = this.init;
    for (let tick = initial_tick;tick <= at_tick; tick++) {
      state = this.apply_tick(state, tick);
    }
    return state;
  }
  constructor(room, init, on_tick, on_post, smooth, tick_rate, tolerance, cache = true, snapshot_stride = 8, snapshot_count = 256) {
    this.room = room;
    this.init = init;
    this.on_tick = on_tick;
    this.on_post = on_post;
    this.smooth = smooth;
    this.tick_rate = tick_rate;
    this.tolerance = tolerance;
    this.room_posts = new Map;
    this.local_posts = new Map;
    this.timeline = new Map;
    this.cache_enabled = cache;
    this.snapshot_stride = Math.max(1, Math.floor(snapshot_stride));
    this.snapshot_count = Math.max(1, Math.floor(snapshot_count));
    this.snapshots = [];
    this.snapshot_start_tick = null;
    this.dirty_from_tick = null;
    this.initial_time_value = null;
    this.initial_tick_value = null;
    on_sync(() => {
      console.log(`[VIBI] synced; watching+loading room=${this.room}`);
      watch(this.room, (post2) => {
        if (post2.name) {
          this.remove_local_post(post2.name);
        }
        this.add_room_post(post2);
      });
      load(this.room, 0);
    });
  }
  time_to_tick(server_time2) {
    return Math.floor(server_time2 * this.tick_rate / 1000);
  }
  server_time() {
    return server_time();
  }
  server_tick() {
    return this.time_to_tick(this.server_time());
  }
  post_count() {
    return this.room_posts.size;
  }
  compute_render_state() {
    const curr_tick = this.server_tick();
    const tick_ms = 1000 / this.tick_rate;
    const tol_ticks = Math.ceil(this.tolerance / tick_ms);
    const rtt_ms = ping();
    const half_rtt = isFinite(rtt_ms) ? Math.ceil(rtt_ms / 2 / tick_ms) : 0;
    const past_ticks = Math.max(tol_ticks, half_rtt + 1);
    const past_tick = Math.max(0, curr_tick - past_ticks);
    const past_state = this.compute_state_at(past_tick);
    const curr_state = this.compute_state_at(curr_tick);
    return this.smooth(past_state, curr_state);
  }
  initial_time() {
    if (this.initial_time_value !== null) {
      return this.initial_time_value;
    }
    const info = this.room_posts.get(0);
    if (!info) {
      return null;
    }
    const t = this.official_time(info.post);
    this.initial_time_value = t;
    this.initial_tick_value = this.time_to_tick(t);
    return t;
  }
  initial_tick() {
    if (this.initial_tick_value !== null) {
      return this.initial_tick_value;
    }
    const t = this.initial_time();
    if (t === null) {
      return null;
    }
    this.initial_tick_value = this.time_to_tick(t);
    return this.initial_tick_value;
  }
  compute_state_at(at_tick) {
    const initial_tick = this.initial_tick();
    if (initial_tick === null) {
      return this.init;
    }
    if (at_tick < initial_tick) {
      return this.init;
    }
    if (!this.cache_enabled) {
      return this.compute_state_at_uncached(initial_tick, at_tick);
    }
    this.ensure_snapshots(at_tick, initial_tick);
    const start_tick = this.snapshot_start_tick;
    if (start_tick === null || this.snapshots.length === 0) {
      return this.init;
    }
    if (at_tick < start_tick) {
      return this.snapshots[0];
    }
    const stride = this.snapshot_stride;
    const snap_index = Math.floor((at_tick - start_tick) / stride);
    const index = Math.min(snap_index, this.snapshots.length - 1);
    const snap_tick = start_tick + index * stride;
    const base_state = this.snapshots[index];
    return this.advance_state(base_state, snap_tick, at_tick);
  }
  post(data) {
    const name = post(this.room, data);
    const t = this.server_time();
    const local_post = {
      room: this.room,
      index: -1,
      server_time: t,
      client_time: t,
      name,
      data
    };
    this.add_local_post(name, local_post);
  }
  compute_current_state() {
    return this.compute_state_at(this.server_tick());
  }
}
export {
  Vibi
};
