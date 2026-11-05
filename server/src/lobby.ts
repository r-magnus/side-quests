import { DurableObject } from "cloudflare:workers";
import {
  HOST_HANDOFF_MS,
  LOBBY_TTL_MS,
  apply,
  authorize,
  canJudge,
  demoPlace,
  distance,
  freshQuestCount,
  hostAfterGrace,
  hostAfterLeave,
  newGame,
  nextHost,
  newSeed,
  waitingPlayers,
  type Action,
  type Actor,
  type ClientMessage,
  type Coordinate,
  type DevOp,
  type GameState,
  type Player,
  type Quest,
  type ServerMessage,
} from "@side-quests/game";
import { Bots } from "./bots";
import { saveToCatalog } from "./catalog";
import { writeQuests } from "./quests";
import { rateQuests } from "./ratings";

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>;
  /** Workers AI: writes and rates quests. Absent (e.g. in tests), the offline deck and estimate fill in. */
  AI?: Ai;
  DEV_TOOLS?: string;
  /** Overrides for testing: how long a quiet lobby lives, and how long before an away host is replaced. */
  LOBBY_TTL_SECONDS?: string;
  HOST_HANDOFF_SECONDS?: string;
  /** Human-written quests from finished games, for LLM inspiration and future curation. Optional — unset means no catalog. */
  CATALOG?: D1Database;
  /** The commit this deployment was built from, set by CI (`--var GIT_SHA:…`). Unset locally. */
  GIT_SHA?: string;
}

/** How old a phone's last reported position can be and still stand in for a proof's location. */
const LOCATION_FRESH_MS = 5 * 60_000;

/**
 * One lobby = one Durable Object. It owns the authoritative game state,
 * applies every action through the shared rules, persists, and broadcasts
 * the new state to every connected phone.
 */
export class Lobby extends DurableObject<Env> {
  state: GameState | null = null;
  /** Last known position of the host — anchors bot photos and demo places. */
  hostLocation?: Coordinate;
  /** Each player's last reported position, for proofs that arrive without one. */
  private lastLocation = new Map<string, { at: number; location: Coordinate }>();
  private sockets = new Map<WebSocket, string>();
  /** When anything last happened here; the lobby is deleted LOBBY_TTL_MS after. */
  private lastActivity = Date.now();
  /** Quests being rated right now, and the timer that batches the next lot. */
  private rating = new Set<string>();
  private rateTimer: ReturnType<typeof setTimeout> | null = null;
  private hostHandoffTimer: ReturnType<typeof setTimeout> | null = null;
  private expiredHandoffHost: string | null = null;
  /** When a top-up adds nothing new (deck exhausted, duplicates), wait before asking again. */
  private aiRetryAfter = 0;
  private bots = new Bots(this);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<GameState>("state")) ?? null;
      this.lastActivity = (await ctx.storage.get<number>("lastActivity")) ?? Date.now();
      // Lobbies saved before these fields existed; and after a restart nobody is connected yet.
      if (this.state) {
        this.state.ready ??= {};
        this.state.away = this.state.players.filter((p) => !p.isBot).map((p) => p.id);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (this.state) return new Response("taken", { status: 409 });
      const { code, host } = (await request.json()) as { code: string; host: Player };
      this.state = newGame(code, host, {
        aiMode: this.env.AI ? "ai" : "offline",
        devTools: this.env.DEV_TOOLS === "1",
      });
      await this.persist();
      return Response.json({ code });
    }

    if (url.pathname === "/info") {
      if (!this.state) return new Response("no such lobby", { status: 404 });
      const host = this.state.players.find((p) => p.id === this.state!.hostId);
      return Response.json({ code: this.state.code, hostName: host?.name ?? "", players: this.state.players.length, phase: this.state.phase });
    }

    // Proof photos live with their lobby: POST …/photos stores one, GET …/photos/:id serves it.
    // (Lobby storage holds values up to 2 MB; the app sends ~200–500 KB JPEGs.)
    const photo = url.pathname.match(/\/photos(?:\/([a-f0-9-]+)\.jpg)?$/);
    if (photo) {
      if (!this.state) return new Response("no such lobby", { status: 404 });
      if (request.method === "POST") return this.storePhoto(request);
      const bytes = photo[1] && (await this.ctx.storage.get<Uint8Array>(`photo:${photo[1]}`));
      if (!bytes) return new Response("not found", { status: 404 });
      return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400, immutable" } });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      if (!this.state) return new Response("no such lobby", { status: 404 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (e) => this.onMessage(server, e.data as string));
      server.addEventListener("close", () => this.dropSocket(server));
      server.addEventListener("error", () => this.dropSocket(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * One alarm does two jobs: end the game when the clock runs out, and delete
   * the lobby (and its photos) once it's been quiet for LOBBY_TTL_MS.
   */
  async alarm() {
    const s = this.state;
    if (!s) return;
    if (s.phase === "playing" && s.endsAt && Date.now() >= s.endsAt - 250) {
      this.dispatch({ type: "setPhase", phase: "ended" }, "server");
      return;
    }
    if (Date.now() >= this.lastActivity + this.ttl - 1000) await this.expire();
    else await this.scheduleAlarm();
  }

  private get ttl() {
    return Number(this.env.LOBBY_TTL_SECONDS) * 1000 || LOBBY_TTL_MS;
  }

  private async scheduleAlarm() {
    const s = this.state;
    if (!s) return;
    const expiry = this.lastActivity + this.ttl;
    const gameEnd = s.phase === "playing" && s.endsAt && s.endsAt > Date.now() ? s.endsAt : Infinity;
    await this.ctx.storage.setAlarm(Math.min(expiry, gameEnd));
  }

  /** JSON { data: <base64 JPEG> } (what the app sends) or a raw image/jpeg body -> { url } */
  private async storePhoto(request: Request): Promise<Response> {
    let bytes: Uint8Array;
    try {
      bytes = request.headers.get("Content-Type")?.includes("json")
        ? Uint8Array.from(atob(((await request.json()) as { data: string }).data), (c) => c.charCodeAt(0))
        : new Uint8Array(await request.arrayBuffer());
    } catch {
      return new Response("expected { data: base64 }", { status: 400 });
    }
    // Refuse anything that isn't a JPEG, so a broken upload fails loudly instead of storing junk.
    if (bytes.length < 100 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return new Response("not a JPEG", { status: 400 });
    if (bytes.length > 2_000_000) return new Response("photo too large", { status: 413 });
    const id = crypto.randomUUID();
    await this.ctx.storage.put(`photo:${id}`, bytes);
    this.lastActivity = Date.now();
    // Relative: each device prefixes the server address it can reach (localhost, 10.0.2.2, LAN IP…).
    return Response.json({ url: `/api/lobbies/${this.state!.code}/photos/${id}.jpg` });
  }

  /** Photos and all: nothing about a quiet lobby outlives its TTL. */
  private async expire() {
    for (const ws of this.sockets.keys()) ws.close(1000, "lobby expired");
    this.sockets.clear();
    this.bots.phaseChanged("lobby");
    this.state = null;
    await this.ctx.storage.deleteAll(); // state, photos and all
    await this.ctx.storage.deleteAlarm();
  }

  // MARK: Messages

  private onMessage(ws: WebSocket, raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { type: "error", message: "bad message" });
    }
    const playerId = this.sockets.get(ws);

    switch (msg.type) {
      case "hello":
        this.sockets.set(ws, msg.player.id);
        if (msg.location) this.noteLocation(msg.player.id, msg.location);
        this.dispatch({ type: "join", player: msg.player }, msg.player.id);
        this.dispatch({ type: "setAway", playerId: msg.player.id, away: false }, "server");
        this.reconcileHost();
        this.send(ws, this.snapshot());
        return;
      case "location":
        if (playerId) this.noteLocation(playerId, msg.location);
        return;
      case "action":
        if (!playerId) return this.send(ws, { type: "error", message: "say hello first" });
        this.dispatch(this.withLocation(msg.action, playerId), playerId, ws);
        return;
      case "dev":
        // Dev shortcuts end games and add bots — host only, so a player can't yank everyone along.
        if (!playerId || playerId !== this.state?.hostId || this.env.DEV_TOOLS !== "1") return;
        this.dev(msg.dev, playerId);
        return;
    }
  }

  /** When a player's last connection closes, mark them away so nobody waits on them. */
  private dropSocket(ws: WebSocket) {
    const playerId = this.sockets.get(ws);
    this.sockets.delete(ws);
    if (!playerId || [...this.sockets.values()].includes(playerId)) return;
    if (this.state?.players.some((p) => p.id === playerId)) this.dispatch({ type: "setAway", playerId, away: true }, "server");
  }

  private noteLocation(playerId: string, location: Coordinate) {
    if (playerId === this.state?.hostId) this.hostLocation = location;
    this.lastLocation.set(playerId, { at: Date.now(), location });
  }

  /**
   * Phones don't always get a fresh fix while the camera is open (iOS pauses
   * location updates for a backgrounded page or app), so a proof can arrive
   * with no location. Fill it in from the last position that phone reported, if
   * it's recent, so the proof still lands on the end-of-game route map.
   */
  private withLocation(action: Action, playerId: string): Action {
    if (action.type !== "submit" || action.submission.location || action.submission.playerId !== playerId) return action;
    const last = this.lastLocation.get(playerId);
    if (!last || Date.now() - last.at > LOCATION_FRESH_MS) return action;
    const quest = this.state?.quests.find((q) => q.id === action.submission.questId);
    return {
      ...action,
      submission: {
        ...action.submission,
        location: last.location,
        distanceFromPlace: quest?.place ? distance(last.location, quest.place.coordinate) : undefined,
      },
    };
  }

  /** Applies an action through the shared rules, then persists, broadcasts and runs host duties. */
  dispatch(action: Action, actor: Actor, from?: WebSocket) {
    const prev = this.state;
    if (!prev) return;
    if (!authorize(prev, action, actor)) {
      if (from) this.send(from, { type: "error", message: `not allowed: ${action.type}` });
      return;
    }
    let next = apply(prev, action);
    const hostLeft = action.type === "leave" && action.playerId === prev.hostId;
    if (hostLeft) {
      this.stopHostHandoffTimer();
      this.expiredHandoffHost = prev.hostId;
      const heir = hostAfterLeave(next, action.playerId, this.connectedPlayers());
      if (heir) next = apply(next, { type: "setHost", playerId: heir.id });
    }
    if (next === prev) return;
    this.state = next;
    if (hostLeft && next.hostId !== prev.hostId) this.expiredHandoffHost = null;
    if (action.type === "setHost") {
      this.stopHostHandoffTimer();
      this.expiredHandoffHost = null;
    }
    if (action.type === "setAway" && !action.away && action.playerId === prev.hostId) {
      this.stopHostHandoffTimer();
      this.expiredHandoffHost = null;
    }
    // Only people keep a lobby alive — bots and the server's own bookkeeping don't.
    void this.persist(actor !== "server");
    this.broadcast();

    if (next.phase !== prev.phase) {
      this.bots.phaseChanged(next.phase);
      if (next.phase === "review") this.writeStarterQuests();
      if (next.phase === "scoreboard") this.ctx.waitUntil(saveToCatalog(this.env.CATALOG, next));
    }
    if (action.type === "requestPhase" && next.transition) this.landTransition(next.transition);
    if (action.type === "addQuest" || action.type === "addAIQuests" || (next.phase === "review" && prev.phase !== "review")) this.rateSoon();
    if (action.type === "setAway" && action.away && action.playerId === next.hostId) this.handOffHostLater(next.hostId);
    this.topUpQuests();
  }

  private connectedPlayers() {
    return new Set(this.sockets.values());
  }

  private stopHostHandoffTimer() {
    if (this.hostHandoffTimer) clearTimeout(this.hostHandoffTimer);
    this.hostHandoffTimer = null;
  }

  /** If the same host is still away after the grace period, an online human takes over. */
  private handOffHostLater(hostId: string) {
    this.stopHostHandoffTimer();
    this.expiredHandoffHost = null;
    this.hostHandoffTimer = setTimeout(() => {
      this.hostHandoffTimer = null;
      this.expiredHandoffHost = hostId;
      this.reconcileHost();
    }, Number(this.env.HOST_HANDOFF_SECONDS) * 1000 || HOST_HANDOFF_MS);
  }

  /** Handles an expired handoff and hosts orphaned by a voluntary lobby departure. */
  private reconcileHost() {
    const s = this.state;
    if (!s) return;
    const hostMissing = !s.players.some((p) => p.id === s.hostId);
    const hostExpired = this.expiredHandoffHost === s.hostId;
    if (!hostMissing && (s.away ?? []).includes(s.hostId) && !hostExpired && !this.hostHandoffTimer) {
      // Durable Object restarts lose in-memory timers; restart the grace period
      // when a connected player first returns to the lobby.
      this.handOffHostLater(s.hostId);
      return;
    }
    if (!hostMissing && !hostExpired) return;
    const heir = hostMissing
      ? nextHost(s, this.connectedPlayers())
      : hostAfterGrace(s, s.hostId, this.connectedPlayers());
    if (heir) this.dispatch({ type: "setHost", playerId: heir.id }, "server");
  }

  /** After everyone's had the heads-up, make the requested phase change — unless the host called it off. */
  private landTransition(t: NonNullable<GameState["transition"]>) {
    setTimeout(() => {
      const s = this.state;
      if (!s?.transition || s.transition.at !== t.at || s.transition.to !== t.to) return;
      if (t.to === "playing" && s.phase === "review") this.dispatch({ type: "startGame" }, "server");
      else this.dispatch({ type: "setPhase", phase: t.to }, "server");
    }, Math.max(0, t.at - Date.now()));
  }

  private snapshot(): ServerMessage {
    return { type: "state", state: this.state!, serverNow: Date.now() };
  }

  private broadcast() {
    const msg = JSON.stringify(this.snapshot());
    for (const ws of this.sockets.keys()) {
      try {
        ws.send(msg);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.sockets.delete(ws);
    }
  }

  private async persist(touch = true) {
    if (!this.state) return;
    if (touch) this.lastActivity = Date.now();
    await this.ctx.storage.put({ state: this.state, lastActivity: this.lastActivity });
    await this.scheduleAlarm();
  }

  // MARK: AI quests

  private writeStarterQuests() {
    const s = this.state!;
    const have = s.quests.filter((q) => q.source === "ai").length;
    if (s.settings.aiStarterCount > have) this.requestAIQuests(s.settings.aiStarterCount - have);
  }

  /** While playing, keep the deck ahead of the players. */
  private topUpQuests() {
    const s = this.state;
    if (!s || s.phase !== "playing" || !s.settings.aiRefill || s.aiWriting || Date.now() < this.aiRetryAfter) return;
    const waiting = waitingPlayers(s).length;
    if (waiting > 0 || freshQuestCount(s) < Math.max(2, s.players.length)) {
      this.requestAIQuests(Math.max(4, s.players.length + waiting));
    }
  }

  requestAIQuests(count: number) {
    const s = this.state;
    if (!s || s.aiWriting) return;
    this.dispatch({ type: "setAIWriting", writing: true }, "server");
    const human = s.quests.filter((q) => q.source === "human").map((q) => q.text);
    const all = s.quests.map((q) => q.text);
    this.ctx.waitUntil(
      writeQuests(this.env.AI, count, human, all).then((texts) => {
        const quests: Quest[] = texts.map((text) => ({ id: crypto.randomUUID(), text, authorId: null, source: "ai", included: true }));
        const before = this.state?.quests.length ?? 0;
        // Back off first: otherwise an empty result would trigger the next top-up immediately, forever.
        this.aiRetryAfter = Date.now() + 30_000;
        this.dispatch({ type: "addAIQuests", quests }, "server");
        if ((this.state?.quests.length ?? 0) > before) this.aiRetryAfter = 0;
      }),
    );
  }

  // MARK: Difficulty ratings

  /** Rate unrated quests shortly — batching quests written in quick succession into one AI call. */
  private rateSoon() {
    if (this.rateTimer) clearTimeout(this.rateTimer);
    this.rateTimer = setTimeout(() => {
      this.rateTimer = null;
      this.rateUnrated();
    }, 1500);
  }

  private rateUnrated() {
    const s = this.state;
    if (!s) return;
    const todo = s.quests.filter((q) => !q.difficulty && !this.rating.has(q.id)).slice(0, 25);
    if (!todo.length) return;
    for (const q of todo) this.rating.add(q.id);
    this.ctx.waitUntil(
      rateQuests(this.env.AI, todo)
        .then((ratings) => this.dispatch({ type: "rateQuests", ratings }, "server"))
        .finally(() => {
          for (const q of todo) this.rating.delete(q.id);
          // More may have arrived (or a batch was capped) while this one ran.
          if (this.state?.quests.some((q) => !q.difficulty && !this.rating.has(q.id))) this.rateSoon();
        }),
    );
  }

  // MARK: Dev shortcuts

  private dev(op: DevOp, requester: string) {
    const s = this.state!;
    switch (op.op) {
      case "addBot":
        this.bots.addBot();
        return;
      case "seed":
        return this.seed(op.phase, op.placeQuest ?? false, requester);
      case "skipToEnd":
        return this.skipToEnd();
      case "simulateRounds":
        return this.simulateRounds(op.rounds);
      case "addTime":
        if (s.endsAt) {
          this.state = { ...s, endsAt: s.endsAt + op.seconds * 1000 };
          void this.persist();
          this.broadcast();
        }
        return;
      case "dealPlaceQuest":
        return this.dealPlaceQuest(requester);
      case "jump":
        if (s.phase !== "ended" && s.phase !== "verifying") this.skipToEnd();
        if (op.phase === "scoreboard") this.botsVote();
        this.dispatch({ type: "setPhase", phase: op.phase }, "server");
        return;
    }
  }

  /** Ends the game now; if it hadn't started, deals and plays a few rounds first. */
  private skipToEnd() {
    const s = this.state!;
    if (s.phase === "lobby" || s.phase === "writing" || s.phase === "review") {
      if (s.players.length < 2) {
        this.bots.addBot();
        this.bots.addBot();
      }
      this.seedQuests();
      this.dispatch({ type: "startGame" }, "server");
      this.simulateRounds(3);
    }
    this.dispatch({ type: "setPhase", phase: "ended" }, "server");
  }

  /** Everyone — humans included — completes their current quest with a stand-in photo. */
  simulateRounds(rounds: number) {
    const base = this.hostLocation ?? { latitude: 37.7749, longitude: -122.4194 };
    for (let round = 0; round < rounds; round++) {
      for (const p of this.state!.players) {
        const s = this.state!;
        const questId = s.assignments[p.id];
        const quest = s.quests.find((q) => q.id === questId);
        if (!quest) continue;
        let spot = jitter({ latitude: base.latitude + (round + 1) * 0.0018, longitude: base.longitude + (round + 1) * 0.0014 }, 0.0012);
        // Most players make it to the spot; some fudge it from a few blocks away.
        if (quest.place) spot = jitter(quest.place.coordinate, Math.random() < 0.75 ? 0.0003 : 0.006);
        this.dispatch(
          {
            type: "submit",
            submission: {
              id: crypto.randomUUID(),
              questId: quest.id,
              playerId: p.id,
              proof: { kind: "standin", seed: newSeed() },
              takenAt: Date.now() + round * 45_000,
              location: spot,
              distanceFromPlace: quest.place ? distance(spot, quest.place.coordinate) : undefined,
              votes: {},
            },
          },
          "server",
        );
      }
    }
  }

  private botsVote() {
    const s = this.state!;
    for (const sub of s.submissions) {
      for (const p of s.players) {
        if (p.isBot && canJudge(s, sub, p.id) && sub.votes[p.id] === undefined) {
          this.dispatch({ type: "vote", submissionId: sub.id, voterId: p.id, approve: Math.random() < 0.8 }, "server");
        }
      }
    }
  }

  private dealPlaceQuest(playerId: string) {
    const s = this.state!;
    const seen = new Set(s.history[playerId] ?? []);
    const q = s.quests.find((q) => q.place && q.included && q.authorId !== playerId && !seen.has(q.id));
    if (!q) return;
    this.state = { ...s, assignments: { ...s.assignments, [playerId]: q.id } };
    void this.persist();
    this.broadcast();
  }

  private seedQuests() {
    const s = this.state!;
    const ideas = [
      "Get a stranger to rate your outfit out of ten",
      "Find the tiniest door in the neighborhood",
      "Pose like a statue next to an actual statue",
      "Convince someone to swap an object with you",
      "Find a car the exact color of your shoes",
      "Hold a 10-second staring contest with a pigeon",
      "Get someone to sign your hand like you're famous",
      "Recreate an album cover in a doorway",
    ];
    const have = new Set(s.quests.map((q) => q.text));
    ideas.forEach((text, n) => {
      if (have.has(text)) return;
      const author = this.state!.players[n % this.state!.players.length];
      const quest: Quest = {
        id: crypto.randomUUID(),
        text,
        place: demoPlace(text, this.hostLocation),
        authorId: n >= 6 ? null : author.id,
        source: n >= 6 ? "ai" : "human",
        included: true,
      };
      this.dispatch(n >= 6 ? { type: "addAIQuests", quests: [quest] } : { type: "addQuest", quest }, "server");
    });
  }

  /** Launch straight into a seeded game at `phase` (you + three bots), for screenshots and UI work. */
  private seed(phase: GameState["phase"], placeQuest: boolean, requester: string) {
    if (this.state!.phase !== "lobby") return;
    for (let i = 0; i < 3; i++) this.bots.addBot();
    if (phase === "lobby") return;
    this.seedQuests();
    this.dispatch({ type: "setPhase", phase: "writing" }, "server");
    if (phase === "writing") return;
    this.dispatch({ type: "setPhase", phase: "review" }, "server");
    if (phase === "review") return;
    this.dispatch({ type: "startGame" }, "server");
    if (placeQuest) this.dealPlaceQuest(requester);
    if (phase === "playing") return;
    this.simulateRounds(3);
    this.dispatch({ type: "setPhase", phase: "ended" }, "server");
    if (phase === "ended") return;
    this.dev({ op: "jump", phase: phase === "scoreboard" ? "scoreboard" : "verifying" }, requester);
  }
}

export function jitter(c: Coordinate, by: number): Coordinate {
  return { latitude: c.latitude + (Math.random() * 2 - 1) * by, longitude: c.longitude + (Math.random() * 2 - 1) * by };
}
