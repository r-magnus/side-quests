import { listCatalog } from "./catalog";
import { walkingRoute } from "./directions";
import { nameSpot, searchPlaces } from "./geocode";
import { parseTile, serveTile } from "./tiles";
import type { Env } from "./lobby";

export { Lobby } from "./lobby";

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const res = await route(request, env, ctx);
    // WebSocket upgrades can't have their headers changed.
    if (res.status === 101) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  if (parts[0] !== "api") return new Response("Side Quests server", { status: 200 });

  // POST /api/lobbies { host } -> { code }
  if (parts[1] === "lobbies" && parts.length === 2 && request.method === "POST") {
    const { host } = (await request.json()) as { host: unknown };
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");
      const res = await lobby(env, code).fetch("https://lobby/init", { method: "POST", body: JSON.stringify({ code, host }) });
      if (res.status !== 409) return res;
    }
    return new Response("couldn't find a free code", { status: 503 });
  }

  // GET /api/lobbies/:code -> summary, …/ws -> WebSocket, …/photos[/:id] -> the lobby's proof photos
  if (parts[1] === "lobbies" && parts[2]) {
    const stub = lobby(env, parts[2].toUpperCase());
    if (parts[3] === "ws" || parts[3] === "photos") return stub.fetch(request);
    return stub.fetch("https://lobby/info");
  }

  // GET /api/tiles/:z/:x/:y.png -> a map tile, cached at the edge (see tiles.ts)
  if (parts[1] === "tiles") {
    const tile = parseTile(parts.slice(2));
    return tile ? serveTile(request, tile.z, tile.x, tile.y, ctx) : new Response("bad tile", { status: 400 });
  }

  // GET /api/directions?from=lat,lng&to=lat,lng -> WalkingRoute
  if (parts[1] === "directions") {
    const parse = (v: string | null) => v?.split(",").map(Number) as [number, number] | undefined;
    const from = parse(url.searchParams.get("from"));
    const to = parse(url.searchParams.get("to"));
    if (!from || !to || [...from, ...to].some(Number.isNaN)) return new Response("from/to required", { status: 400 });
    const route = await walkingRoute(from, to);
    return route ? Response.json(route) : new Response("no route", { status: 502 });
  }

  // GET /api/geocode?q=…&near=lat,lng -> PlaceHit[];  GET /api/geocode?at=lat,lng -> { name }
  if (parts[1] === "geocode") {
    const pair = (v: string | null) => {
      const n = v?.split(",").map(Number);
      return n && n.length === 2 && !n.some(Number.isNaN) ? (n as [number, number]) : undefined;
    };
    const at = pair(url.searchParams.get("at"));
    const q = url.searchParams.get("q")?.trim();
    if (!at && !q) return new Response("q or at required", { status: 400 });
    try {
      if (at) return Response.json({ name: await nameSpot(at[0], at[1]) });
      return Response.json(await searchPlaces(q!.slice(0, 120), pair(url.searchParams.get("near"))));
    } catch {
      return new Response("Place lookup is temporarily unavailable", { status: 503 });
    }
  }

  // POST /api/log — the app reports its own errors here, so they show up in Cloudflare's logs.
  if (parts[1] === "log" && request.method === "POST") {
    const entry = (await request.text()).slice(0, 4000);
    console.warn(`client: ${entry}`);
    return new Response(null, { status: 204 });
  }

  // `sha` is the commit this deployment was built from (set by CI) — the simplest way to
  // confirm a push actually made it to production, and which one is currently live.
  if (parts[1] === "health") return Response.json({ ok: true, ai: env.AI ? "ai" : "offline", sha: env.GIT_SHA ?? "local" });

  // GET /api/catalog/quests?limit=20&verified=1&random=1 -> CatalogEntry[]
  // Human-written quests pulled from finished games (not AI ones, and not just written
  // ones) — for LLM inspiration or future curation. Nothing in the app calls this yet.
  if (parts[1] === "catalog" && parts[2] === "quests") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const verifiedOnly = url.searchParams.get("verified") === "1";
    const random = url.searchParams.get("random") === "1";
    return Response.json(await listCatalog(env.CATALOG, { limit, verifiedOnly, random }));
  }

  return new Response("not found", { status: 404 });
}

function lobby(env: Env, code: string) {
  return env.LOBBY.get(env.LOBBY.idFromName(code));
}
