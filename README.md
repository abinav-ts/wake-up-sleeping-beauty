# Wake Up, Sleeping Beauty

A PWA alarm clock with a twist. Let an alarm ring (or snooze it) for **x** minutes and the next alarm
you set for 24h-or-later after that ring is shifted by a hidden random amount, `Normal(0, 15 min * x)`,
earlier or later, with no hard bound. The only escape is **10,000 steps** (from Apple Health) between
the ring and the shifted alarm firing. The shifted time lives only on the server and is never sent to the page.

Stack: Cloudflare Worker + D1 + cron (every minute) + Web Push (VAPID), static PWA in `public/`.

**Identity:** there is no login. Each browser generates a random 128-bit ID on first launch and sends it as
`X-Device-Id`; every alarm, chaos state, step count and push subscription is keyed to it, so many people can
use one deployment without seeing each other. The ID is effectively the key (copy or restore it from the
app's *This device* card). Guard rails: 20 new devices per IP per hour, 2000 users, 25 open alarms each,
users inactive for 90 days are deleted.

## Rules as implemented
- Alarm rings -> `x` = minutes from first ring to final Stop (snoozes included, auto-stop at 30 min), minus a 3 minute reaction-time grace (floor 0).
- That ring starts the chaos clock at its actual ring time `T1`.
- Any alarm with intended time >= `T1 + 24h` gets a hidden shift (floor: never earlier than now + 1 min).
  Alarms pending when the ring finishes are re-rolled; later alarms are rolled on creation.
- Steps since `T1` >= 10,000 before the shifted alarm fires -> shift removed (alarm rings at the intended time).
- Each alarm that rings replaces the chaos state (new `T1`, new `x`).

## Deploy
```sh
./deploy.sh        # wrangler login (if needed) -> create D1 -> deploy. No token or secret to set.
```
Open the `workers.dev` URL on the iPhone in **Safari**, Share -> **Add to Home Screen**, open it from the Home
Screen, tap **Enable alarm notifications**, then **Send test**.

### Upgrading from the old single-token version
Data from the token era is kept under an empty owner until a device claims it. The first launch of the new
app on a phone that still has the old token (saved in its storage) presents it once and the alarms, push
subscription and step progress move to that device's new ID. Afterwards remove the old secret:
```sh
npx wrangler secret delete TOKEN && rm -f .token
```

## Steps via iOS Shortcuts
Health data can't be read from the web, so a Shortcut pushes it. Tap **Copy steps webhook** in the app to get
your URL (it contains your ID, so keep it private). Create a Shortcut:
1. **Get Contents of URL** `https://<your-worker>.workers.dev/api/steps/since?u=<YOUR-ID>` -> **Get Dictionary Value** `since_iso`.
2. **Get Dates from Input** (the ISO string) -> **Find Health Samples** where *Type is Steps* and *Start Date is after* that date.
3. **Calculate Statistics** (Sum) over the samples.
4. **Get Contents of URL** `https://<your-worker>.workers.dev/api/steps?u=<YOUR-ID>`, Method **POST**,
   Request Body **JSON**, field `steps` = the sum (as a Number).

Then Shortcuts -> Automation -> Time of Day, a few times a day (e.g. every 2-3h), *Run Immediately*.
A goal reached between automation runs is only noticed on the next run.

## Dev
`npm test` runs the logic, identity-isolation and worker-lifecycle tests (in-memory SQLite standing in for D1).

## Docs (GitHub Pages, served from `docs/`)
- `docs/viva.html`: stack, architecture and the logic behind the chaos
- `docs/transcript.html`: the Claude Code build conversation, one collapsible response per turn
  (regenerate with `python3 scripts/build_transcript.py <session.jsonl>`; secrets are redacted)

## Publish
`./publish.sh` creates the public GitHub repo, pushes, and enables Pages from `main:/docs`.
