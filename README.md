# Side Quests

A party game for friend groups: everyone writes side quests, the deck gets dealt out at random, and players race the clock to complete as many as they can, proving each one with a photo. Then the lobby votes on the proof and crowns a winner.

This game was created by @sugarfig @r-magnus @jingpeng7527 @aaccaa19 for the unwrap hackathon in 2026.

## Getting started (any machine)

**You need:** [Node.js 24](https://nodejs.org/) or newer (it includes npm), and Git. Works on macOS, Windows and Linux.

```sh
git clone https://github.com/r-magnus/side-quests.git
cd side-quests
npm install
```

AI-written quests and AI difficulty ratings use Cloudflare Workers AI through the server's `AI` binding. There's no key to set up; `wrangler dev` uses your Cloudflare login. Without it the game still works, because an offline quest deck and a built-in difficulty estimate fill in.

### Play a game: `npm run party`

```sh
npm run party
```

This is the one command for playing on real phones. It:

1. builds the web version of the app,
2. starts the game server on port 8787 (or reuses one that's already running),
3. opens a free, temporary public link with a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (no Cloudflare account needed),
4. opens a big QR code for that link in your browser.

Then everyone scans the QR code with their phone camera and plays in the phone's browser, with no app or account. One person taps **Host a lobby**; everyone else scans the lobby's own QR code or taps the **Invite friends** link. **Ctrl+C** ends the party. Each run gets a new link, and anyone with the link can reach your game while it runs.

The tunnel needs `cloudflared` installed once:

| OS | Install |
|---|---|
| macOS | `brew install cloudflared` |
| Windows | `winget install --id Cloudflare.cloudflared` |
| Linux | a package from [Cloudflare's downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) |

**Everyone on the same Wi-Fi?** `npm run party:local` skips the tunnel and prints a link like `http://192.168.1.20:8787`. No `cloudflared` needed. Two limits: guest and office networks often block devices from reaching each other, and browsers only share location over https, so quests with places can't show your position. Use `npm run party` for those.

**Other handy commands:**

- `npm run qr -- <url>`: show a big QR code for any link, such as a deployed `workers.dev` address.
- `npm run deploy`: publish to Cloudflare for a permanent link that works without your computer (see [Deploy](#deploy)).

**If something goes wrong:**

| Problem | Fix |
|---|---|
| "cloudflared isn't installed" | Install it (table above), or use `npm run party:local`. |
| The tunnel won't start | The script prints cloudflared's own error. Some networks block tunnels entirely; use `party:local` or another network. |
| The phone shows "can't be reached" at first | Brand-new links take up to half a minute to appear. Wait and reload. |
| macOS asks whether `node` or `workerd` may accept connections | Click **Allow**. That's how phones on your Wi-Fi reach the game. |
| Port 8787 is busy | Another game server is already running. `party` reuses it, or stop it first. |
| Changes don't show up | `party` rebuilds the web app each run. Restart it after editing code, and reload the page on phones. |

More ways to run on phones (Expo Go for development, installed iOS and Android builds) are in [docs/run-on-a-phone.md](docs/run-on-a-phone.md).

## Layout

```
packages/game/   Shared TypeScript: types, game rules, wire protocol, places (+ tests)
server/          Cloudflare Worker — one Durable Object per lobby, photos stored with each lobby,
                 AI quest writer (Workers AI), walking directions, bots, dev shortcuts
app/             Expo (React Native + expo-router) app for iOS, Android and web
legacy-swiftui/  The original SwiftUI prototype, kept as a reference
```

The server is the referee: every phone sends actions, the lobby's Durable Object runs them through the shared rules in `packages/game` (checking who's allowed to do what), and broadcasts the new state to everyone. Phones never talk to each other directly, so iPhones, Android phones and browsers can share a lobby.

**Moving the game along:** only the host moves between phases, and never abruptly. A host request shows everyone a 3-second "moving to…" banner, which the host can cancel, before the server lands it. While writing and judging, players tap **I'm done**; the host sees how many are done and is asked to confirm before moving on early. Players whose phones drop off are marked away and don't hold anyone up. A half-written quest is saved if the phase changes, and a photo snapped before the buzzer still counts if its upload finishes just after.

**Scoring:** harder quests are worth more. Each quest is rated as it's written, from 1 to 5 on time (how long it takes), nerve (how awkward or embarrassing it is) and effort (travel, props, physical work); the average becomes 1–5 points. Ratings come from Workers AI (`server/src/ratings.ts`), otherwise from an offline keyword estimate. Authors see their quest's rating while writing; in review the host sees every rating with its reason and can overrule it with − / +, and the rater never overwrites the host's call. A verified proof earns its quest's points. Turn off **Harder = more points** in game settings to make every quest worth 1.

## Develop locally

For working on the code with live reload in a simulator, emulator or Expo Go (`npm run party` is for playing; it serves a fixed build):

```sh
# 1. Lobby server on :8787 (no Cloudflare account needed for local dev)
npm run server

# 2. App — then press i (iOS simulator), a (Android emulator) or w (web)
npm run app        # or: cd app && npx expo start
```

Run Expo from `app/` (that's what `npm run app` does). Running `npx expo start` from the repo root starts Metro without the app — web shows a blank page and Expo Go may complain about signing in.

The app finds the server on the same machine that serves the JS bundle, so simulators, emulators and real phones on the same Wi-Fi all just work. To point it elsewhere, set `EXPO_PUBLIC_SERVER_URL`.

**AI quests:** written and rated by Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, set in `server/src/ai.ts`) through the `AI` binding in `wrangler.jsonc`. It has a free daily allowance and needs no API key. If it fails, a built-in offline deck fills in.

**Joining:** the host's lobby screen shows a QR code and a four-letter code. Friends tap **Join a lobby** and scan it, or type the letters — from the app or a browser.

## Testing

```sh
npm test            # game rules, difficulty ratings and geocoding (Node 24)
npm run typecheck   # all workspaces
cd app && npx expo lint
```

The repeatable phone-browser check is documented in [docs/mobile-testing.md](docs/mobile-testing.md). The checkpoint continuation and verified results are in [docs/checkpoint-continuation.md](docs/checkpoint-continuation.md).

**Dev shortcuts are hidden by default.** To show them, build or start the app with `EXPO_PUBLIC_DEV_MENU=1` (for example `EXPO_PUBLIC_DEV_MENU=1 npm run party`). The server must also allow them (`DEV_TOOLS=1`, the default locally). The `?demo=<phase>` links work either way.

**Solo play:** in a lobby, tap **+ Add a bot**. Bots write quests, complete them with stand-in photos, and vote.

**Dev shortcuts** (server runs with `DEV_TOOLS=1`, host only): tap the black **DEV** tag in the header of any game screen to skip to the end, have everyone complete a quest, add time, deal yourself a quest with a place, or jump to verification or the scoreboard.

**Deep links for driving simulators** (dev): open the app with `?demo=<phase>` to land in a seeded game (you + three bots), `&place=1` to be dealt a quest with a place, `?create=1` for an empty lobby, or `?join=CODE&name=Ana` to join one.

```sh
xcrun simctl openurl booted "exp://<your-ip>:8081/--/?demo=playing&place=1"
adb shell am start -a android.intent.action.VIEW -d "'exp://<your-ip>:8081/--/?join=ABCD&name=Ana'"
# web: http://localhost:8081/?demo=verifying
```

On a cold start Expo Go drops the link's parameters — open the project first, then the link.

## Deploy

**Server and web app** (one Worker serves both, so join links work in any browser):

```sh
cd server && npx wrangler login && cd ..    # once
npm run deploy                              # builds the web app, deploys with DEV_TOOLS off
```

It prints your permanent address, `https://side-quests.<your-subdomain>.workers.dev`. Lobbies and their photos live in Durable Object storage (free tier) and are deleted after 24 quiet hours. Nothing else to set up. AI-written quests work out of the box through the Workers AI binding.

**App:** see [docs/run-on-a-phone.md](docs/run-on-a-phone.md) for installable Android and iPhone builds (EAS), TestFlight, and store release.

**Web:** included above. The Worker serves `app/dist`, so `https://<your-worker>/join/ABCD` opens the game in any browser.

## Notes and limits

- **Maps:** react-native-maps (Apple Maps on iOS, Google Maps on Android). Android builds (not Expo Go) need a Google Maps API key via `GOOGLE_MAPS_ANDROID_API_KEY` — see the phone guide. On web, interactive Leaflet maps use OpenStreetMap tiles with a paper tint. The place picker supports tapping a pin, searching, and "use my spot".
- **Walking routes** come from the free FOSSGIS OSRM router (OpenStreetMap data, fair-use). Swap in a keyed provider or self-hosted OSRM before launch.
- **Place search and automatic pin names** use the server’s `/api/geocode` endpoint backed by OpenStreetMap Nominatim on every platform. If the provider is unavailable, map pins and manual names still work; search shows an availability error.
- **Photos** are downscaled on the phone and stored with their lobby; the game state only carries their paths. A lobby and its photos are deleted 24 hours after anything last happened in it.
- **Hosting** passes to another player if the host's phone has been away for a minute, so a game never stalls.
