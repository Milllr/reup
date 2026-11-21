# Run and deploy

Nothing on this page was run against Cloudflare from the build session: there was no account to run it on. The local half was run and works. The Cloudflare half is written from the wrangler docs and needs one careful pass by a person.

## On one laptop

| What | Command |
| --- | --- |
| Install | `node hw/hw.mjs run setup` |
| Hub, store and buyer together, nothing leaves the laptop | `npm run stack` |
| The same with the real buyer on the live web | `infisical run -- node tools/dev.mjs --tinyfish` |
| Walk the whole loop and check every beat | `npm run smoke` |
| The eye with a drawn board, from services/eye | `python -m reup_eye --hub http://localhost:3000 --sim` |
| The eye with the cameras, from services/eye | `python -m reup_eye --hub http://localhost:3000` |
| The shelf node with stand in vision, from edge/qnx | `HUB_URL=http://localhost:3000 DEVICE_TOKEN=dev-device-token VISION_CMD="python3 tools/fake_vision.py" ./run.sh` |
| Everything, checked | `node hw/hw.mjs check` |

Then open http://localhost:3000 for the TV, http://localhost:3000/m for a phone and http://localhost:3000/ops for the operator (token `dev-ops-token` on a laptop).

## Cloudflare, once

1. Sign in: `npx wrangler login`
2. Make the two databases: `npx wrangler d1 create reup-hub` and `npx wrangler d1 create offcut-supply`
3. Paste each `database_id` it prints into `apps/hub/wrangler.jsonc` and `apps/supply/wrangler.jsonc`, in place of the zeros.
4. Secrets, from Infisical, one line a Worker. Keep the hub's under the Infisical path `/hub` and the store's under `/supply`.
   * From apps/hub: `infisical export --path=/hub --format=dotenv | npx wrangler secret bulk`
   * From apps/supply: `infisical export --path=/supply --format=dotenv | npx wrangler secret bulk`
5. Deploy both: `npm run deploy`
6. Write the two workers.dev addresses in docs/DECISIONS.md. Until DNS is on Cloudflare, set `SUPPLY_URL` in `apps/hub/wrangler.jsonc` and `HUB_URL` in `apps/supply/wrangler.jsonc` to those addresses and deploy again.

| Worker | Secrets it reads |
| --- | --- |
| reup-hub | DEVICE_TOKEN, OPS_TOKEN, APPROVE_KEY, SUPPLY_WEBHOOK_SECRET, GEMINI_API_KEY |
| offcut-supply | SUPPLY_WEBHOOK_SECRET (the same value), ACCOUNT_PASSWORD, ADMIN_PASSWORD |

Without a secret, each Worker falls back to its `dev-` value. That is fine on a laptop and wrong on the internet: set all of them before the address is shared.

## Deploys after that

`.github/workflows/deploy.yml` deploys main after ci passes. It needs two repository secrets, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Until they exist, and until the database ids are real, it skips and stays green.

## Demo day, in this order

1. Hub and store are deployed. `curl https://wheredidallmyinventorygo.wtf/api/health` answers.
2. The laptop that drives the TV: start the eye from services/eye, then open the hub in Chrome on that same laptop. The stream is served from localhost on purpose.
3. Buyer, on any laptop: `infisical run -- npm run start -w services/buyer`. Its first lines say whether the TinyFish key and profile are set.
4. Pi: `./run.sh` in edge/qnx. The operator page shows the node's level.
5. Operator page: draw the zones, save the empty board, then Reset demo.
6. Between judges: put the parts back, take the taught part off the teach spot, press Reset demo.

## Known limits on demo day

* A price check is reused for 10 minutes. A second judge inside that window sees the prices at once and only the Offcut pane shopping live. To check prices live for every judge, change `TEN_MINUTES` in `apps/hub/src/orders/index.ts`.
* The two retailers in `services/buyer/suppliers.json` are untested. Run each search in the TinyFish playground three times before trusting it (task BH2).
* Naming a taught part needs `GEMINI_API_KEY`. Without it the screen says so and a typed name works.
