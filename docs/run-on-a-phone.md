# Running Side Quests on a phone

| | **Play in the browser** | **Expo Go** | **Installed build** |
|---|---|---|---|
| For | Friends joining a game — and the quickest way to play | You, while developing | Playing without your laptop; app-store style |
| Players need | Their phone's camera and browser. No app, no account | Expo Go, signed in to **your** Expo account | The installed app |
| Time | 1 minute | 5 minutes | 30–60 minutes the first time |
| Laptop needed? | Yes, it runs the game | Yes | No (needs a deployed server) |

---

## Play in the browser: `npm run party`

The game server also serves the web version of the app, so the whole game is one address. Friends scan a QR code and play in their phone's browser.

```sh
npm install            # first time only
brew install cloudflared   # first time only (free, no account)
npm run party
```

It builds the web app, starts the game server, opens a free Cloudflare tunnel, and opens a big QR code for its `https://….trycloudflare.com` link in your browser. Put it on screen for everyone. Then:

1. Everyone scans the QR code with their phone's camera and taps the link.
2. One person (the host) taps **Create lobby**.
3. Everyone else scans the **lobby's** QR code, or taps **Invite friends** to send the link to a group chat. The link opens a "You're invited" page that only asks for a name.

Anyone with the link can reach your game while it runs; **Ctrl+C** ends the party. Each run gets a new link.

**If the tunnel won't start**, the script prints cloudflared's own error. Some office and campus networks block Cloudflare tunnels altogether; the script already uses the HTTPS mode that gets through most of them. If the link shows "can't be reached" on a phone at first, wait half a minute: brand-new links take a moment to appear.

**A QR code for any link,** such as your deployed `workers.dev` address: `npm run qr -- https://side-quests.<you>.workers.dev`. (QR codes drawn in a terminal often break up into stripes, which is why these open in the browser.)

**Everyone on the same Wi-Fi?** `npm run party:local` skips the tunnel and prints a link like `http://192.168.1.20:8787`. Quests with places can't show your position there: browsers only share location over https. Use `npm run party` for those.

**In the browser:** proof photos use the phone's camera through the browser's photo picker. Maps are view-only, and places are set with "Use my spot".

---

## Expo Go (for developing)

Expo Go runs the native app straight from your Mac and reloads as you edit. **It's a developer tool, not for friends:** Expo Go on an iPhone only opens a project when it's signed in to the same Expo account as the Expo CLI on your Mac. Friends should use the browser link above, or an installed build.

1. Install **Expo Go** on your phone, and sign in to Expo Go and the CLI with the same account:

   ```sh
   cd app && npx expo login
   ```

2. Start the server and the app (from the repo root, in two terminals):

   ```sh
   npm run server    # game server on port 8787
   npm run app       # prints a QR code — always start Expo from app/ (this does)
   ```

   If macOS asks whether `node` or `workerd` may accept incoming network connections, click **Allow**.
3. Scan the QR code: with the Camera app on iPhone, or Expo Go's **Scan QR code** on Android.

On the same Wi-Fi the app finds the game server by itself, using your Mac's address. **Edits show up live.**

### On a different network (`--tunnel`)

`npx expo start --tunnel` gives the *app* a public address, but not the game server, so it can't create or join lobbies until you give the server one too:

```sh
cloudflared tunnel --url http://127.0.0.1:8787     # 127.0.0.1, not localhost (see below)
cd app
EXPO_PUBLIC_SERVER_URL=https://<printed-address>.trycloudflare.com npx expo start --tunnel --clear
```

**Use `127.0.0.1`, not `localhost`.** On a Mac, `localhost` resolves to the IPv6 address first, where the game server isn't listening. The tunnel then answers with a 502 and the app says it can't reach the server behind the tunnel.

### If it doesn't connect

| Symptom | Fix |
|---|---|
| Expo Go spins, or can't connect to the dev server | Phone and Mac must be on the same Wi-Fi, and guest/office networks often block devices from seeing each other. Use `--tunnel`, or the browser link. |
| Expo Go asks you to sign in | Sign in to Expo Go with the same account as `npx expo login` on your Mac. For other people, send the browser link instead. |
| **Can't reach the game server at http://…:8787** | Make sure `npm run server` is running and incoming connections are allowed. |
| **The tunnel … can't reach the game server behind it** | Point the tunnel at `http://127.0.0.1:8787`, not `localhost`. |
| **You're running through a tunnel…** | Set `EXPO_PUBLIC_SERVER_URL` as shown above. |
| The browser shows a blank page (Metro on port 8081) | Expo was started from the repo root. Start it from `app/` (`npm run app`). |
| Expo Go says the project needs a newer/older SDK | Update Expo Go. This project uses Expo SDK 58. |

---

## Option 2: An installed build

An installed build is the real app, with its own name and icon, and it keeps working away from your laptop. It talks to a game server on the internet, so deploy that first.

### Step 1: Deploy the game server (once)

You need a free Cloudflare account.

```sh
cd server && npx wrangler login && cd ..
npm run deploy
```

`deploy` builds the web app, deploys it with the game server, and prints the address, like `https://side-quests.<your-subdomain>.workers.dev`. Check it with `curl <url>/api/health`. The DEV menu (bots, skip to end) is off in deployed builds, and locally only shows when the app is built with `EXPO_PUBLIC_DEV_MENU=1`.

That address is also a permanent browser link: anyone can open it and play, no tunnel or laptop needed.

### Step 2: Point the app at it

In `app/eas.json`, replace `https://side-quests.<your-subdomain>.workers.dev` with your URL in both the `preview` and `production` profiles.

### Step 3: Set up EAS (once)

EAS is Expo's build service: it builds and signs the app in the cloud, so you don't need Android Studio, and for iPhones it manages Apple's certificates for you. You need a free Expo account.

```sh
cd app
npx eas-cli@latest login
npx eas-cli@latest init     # links the project to your Expo account
```

### Step 4a: Android

1. **Get a Google Maps key.** Android builds need one for maps (Expo Go didn't). In the [Google Cloud console](https://console.cloud.google.com/), create a project, enable **Maps SDK for Android**, and create an API key. Under **Application restrictions**, choose **Android apps** and add package `com.sidequests.app` with the SHA-1 fingerprint shown by `npx eas-cli@latest credentials -p android` (run it after your first build, then update the restriction).
2. **Add the key** to the `preview` (and `production`) profile's `env` in `app/eas.json`:

   ```json
   "env": {
     "EXPO_PUBLIC_SERVER_URL": "https://side-quests.<your-subdomain>.workers.dev",
     "GOOGLE_MAPS_ANDROID_API_KEY": "AIza…"
   }
   ```

   This key ends up inside the app either way, so it isn't a secret. The package and fingerprint restriction is what protects it. `app/app.config.js` reads it at build time.
3. **Build:**

   ```sh
   npx eas-cli@latest build -p android --profile preview
   ```

   The `preview` profile makes an `.apk` you can install directly. When the build finishes (~10–15 minutes), EAS prints a link and QR code.
4. **Install:** open the link on the phone, download the `.apk`, and open it. Android will ask to allow installs from your browser ("Install unknown apps"); allow it once.

Anyone with the link can install it. Send it to friends the same way.

### Step 4b: iPhone

Apple only lets apps onto iPhones that are signed for them. Pick one:

**A. Internal build (needs a $99/year Apple Developer account).** Best for you and up to 100 friends' iPhones.

1. Register each iPhone:

   ```sh
   npx eas-cli@latest device:create
   ```

   It prints a link and QR code. Open it on the iPhone and install the small profile it offers; that tells Apple about the device.
2. Build:

   ```sh
   npx eas-cli@latest build -p ios --profile preview
   ```

   Sign in with your Apple ID when asked; EAS creates the certificates.
3. Open the link EAS prints on the iPhone and tap **Install**.
4. **iOS 16 and later:** turn on **Settings → Privacy & Security → Developer Mode**, restart when prompted, and confirm.

Add a friend's iPhone later by registering it (step 1) and building again.

**B. TestFlight (same paid account).** Best for larger groups; no device registration, and testers install from Apple's TestFlight app.

```sh
npx eas-cli@latest build -p ios --profile production
npx eas-cli@latest submit -p ios
```

Then add testers in App Store Connect → your app → TestFlight. The first build goes through a short Apple review before external testers can install it.

**C. Free, from your Mac (no paid account).** Good for your own iPhone only. It needs Xcode and a USB cable, and the app stops opening after 7 days until you reinstall.

1. Plug in the iPhone, unlock it, and tap **Trust**. Turn on Developer Mode as in A.4.
2. From `app/`:

   ```sh
   EXPO_PUBLIC_SERVER_URL=https://side-quests.<your-subdomain>.workers.dev \
     npx expo run:ios --device --configuration Release
   ```

   Pick your iPhone from the list. If Xcode reports a signing error, open `app/ios/SideQuests.xcworkspace`, select the app target → **Signing & Capabilities**, choose your personal team (sign in with your Apple ID), and run the command again.
3. On the iPhone: **Settings → General → VPN & Device Management**, tap your Apple ID, then **Trust**.

The same works for Android over USB without EAS: enable **USB debugging** on the phone, then run `npx expo run:android --device --variant release` with the same `EXPO_PUBLIC_SERVER_URL` (and `GOOGLE_MAPS_ANDROID_API_KEY` for maps).

`expo run` generates `app/ios` and `app/android` folders. They're build output, already ignored by git; never edit them by hand.

### Shipping updates

- **Changes to screens, rules or styling** (anything in JavaScript/TypeScript): `npx eas-cli@latest update` pushes them to installed builds without reinstalling. Players get them the next time they open the app.
- **Changes to native setup** (new native packages, permissions, `app.json` plugins): build and install again.
- **Server changes:** `cd server && npx wrangler deploy`. Every build picks them up immediately.

### Store release

When you're ready for the App Store and Google Play: `npx eas-cli@latest build -p all --profile production`, then `npx eas-cli@latest submit`. Google Play needs a $25 one-time developer account. Both stores need listing details (screenshots, description, privacy policy) before review.
