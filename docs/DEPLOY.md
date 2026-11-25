# Run and deploy

## On one laptop

| What | Command |
| --- | --- |
| Install | `npm install`, then `python -m pip install -r services/eye/requirements-dev.txt` |
| Hub, store and buyer together, nothing leaves the laptop | `npm run stack` |
| The same with the real buyer on the live web | `infisical run -- node tools/dev.mjs --tinyfish` |
| Walk the whole loop and check every beat | `npm run smoke` |
| The eye with a drawn board, from services/eye | `python -m reup_eye --hub http://localhost:3000 --sim` |
| The eye with the cameras, from services/eye | `python -m reup_eye --hub http://localhost:3000` |
| The shelf node with stand in vision, from edge/qnx | `HUB_URL=http://localhost:3000 DEVICE_TOKEN=dev-device-token VISION_CMD="python3 tools/fake_vision.py" ./run.sh` |
| Everything, checked | `npm run check` |

Then open http://localhost:3000 for the TV, http://localhost:3000/m for a phone, http://localhost:3000/analytics for the analytics page and http://localhost:3000/ops for the operator (token `dev-ops-token` on a laptop).

## Cloudflare

Two Workers, each with its own D1 database: the hub (`apps/hub`) and Offcut Supply, the demo store (`apps/supply`). From the repo root, `npm run deploy` builds the web app, applies the migrations and deploys both.

Neither wrangler.jsonc holds a database id, so the databases are yours. The first time, create them by name: `npx wrangler d1 create reup-hub` and `npx wrangler d1 create offcut-supply`. Wrangler 4.45 or newer finds them by name on every deploy after that.

Before the first deploy, change three things to your own addresses: `routes` in both wrangler.jsonc files, `SUPPLY_URL` in the hub's and `HUB_URL` in the store's.

| Worker | Secrets it reads |
| --- | --- |
| reup-hub | DEVICE_TOKEN, OPS_TOKEN, APPROVE_KEY, SUPPLY_WEBHOOK_SECRET, GEMINI_API_KEY |
| offcut-supply | SUPPLY_WEBHOOK_SECRET (the same value), ACCOUNT_PASSWORD, ADMIN_PASSWORD |

Without a secret, a Worker falls back to its `dev-` value. That is fine on a laptop and wrong on the internet: set every one before the address is shared. With the hub's secrets under the Infisical path `/hub` and the store's under `/supply`, it is one line a Worker.

* From apps/hub: `infisical export --path=/hub --format=dotenv | npx wrangler secret bulk`
* From apps/supply: `infisical export --path=/supply --format=dotenv | npx wrangler secret bulk`
* `node tools/secrets.mjs` asks for the two keys only a person has (Gemini, TinyFish) with hidden input, stores them in Infisical and sets the Gemini key on the hub.
* A secret that changes does not reach a running Worker until the next deploy.
* A deploy reaches the running hub at once (`code_update_strategy` is `immediate` in `apps/hub/wrangler.jsonc`). Cloudflare's default lets a busy Durable Object keep its old code for up to 5 minutes, which is how a fix can look like it did not work.
* `GEMINI_MODEL` in `apps/hub/wrangler.jsonc` lists several models with commas between. The hub asks the first, asks the next as well after 2.5 seconds without an answer, and takes the first good answer.
* Cloudflare copies the old host's records when a domain is added, and it will not attach a Worker to a name that already has records (error 100117). Delete the copied A records for that name in the dashboard, then deploy.

## Demo day, in this order

1. Hub and store are deployed. `curl https://wheredidallmyinventorygo.wtf/api/health` answers.
2. The laptop that drives the TV: start the eye from services/eye, then open the hub in Chrome on that same laptop. The stream is served from localhost on purpose.
3. Buyer, on any laptop: `infisical run -- npm run start -w services/buyer`. Its first lines say whether the TinyFish key and profile are set.
4. Pi: `./run.sh` in edge/qnx. The operator page shows the node's level.
5. Operator page: draw the zones, save the empty board, then Reset demo.
6. Between judges: put the parts back, take the taught part off the teach spot, press Reset demo.
