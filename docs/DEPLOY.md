# Run and deploy

The local half and the Cloudflare deploy were both run. The secrets line and the deploy workflow were not: they wait on the Infisical project and a Cloudflare API token.

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

Then open http://localhost:3000 for the TV, http://localhost:3000/m for a phone, http://localhost:3000/analytics for the analytics page and http://localhost:3000/ops for the operator (token `dev-ops-token` on a laptop).

## Cloudflare

Deployed Sat Nov 21 with wrangler from Miller's laptop.

| What | Address |
| --- | --- |
| Hub: board, phone, operator, API | https://wheredidallmyinventorygo.wtf |
| Analytics | https://wheredidallmyinventorygo.wtf/analytics |
| Offcut Supply | https://offcut.wheredidallmyinventorygo.wtf |

The workers.dev addresses still answer (`workers_dev` is on in both configs): https://wheredidallmyinventorygo.wtf and https://offcut.wheredidallmyinventorygo.wtf. Anything that still posts to them keeps working.

The two D1 databases exist and their ids are in `apps/hub/wrangler.jsonc` and `apps/supply/wrangler.jsonc`. Deploy again after a change, from the repo root: `npm run deploy`

Done Sat Nov 21, 8 PM: the repo is linked to the Infisical project hw13, and `GEMINI_API_KEY` and `TINYFISH_API_KEY` are in it at the root path. The Gemini key is on the deployed hub.

* A key only a person has: `node tools/secrets.mjs` asks for it with hidden input, stores it in Infisical and sets it on the hub. Already in Infisical: `infisical run -- node tools/secrets.mjs --push`
* Then deploy once more, `npm run deploy`. A secret that changes does not reach the hub that is already running until a deploy restarts it.
* A deploy now reaches the running hub at once (`code_update_strategy` is `immediate` in `apps/hub/wrangler.jsonc`). Cloudflare's default since Oct 30 2026 lets a busy Durable Object keep its old code for up to 5 minutes, which is how a fix looked like it had not worked.
* `GEMINI_MODEL` in `apps/hub/wrangler.jsonc` lists several models with commas between. The hub asks the first, asks the next as well after 2.5 seconds without an answer, and takes the first good answer, so one slow or overloaded model does not stop a part being named.

Still to do:

1. The other secrets. The Workers run on their `dev-` values for the tokens and passwords until this is done. From Infisical, one line a Worker, with the hub's secrets under the Infisical path `/hub` and the store's under `/supply`.
   * From apps/hub: `infisical export --path=/hub --format=dotenv | npx wrangler secret bulk`
   * From apps/supply: `infisical export --path=/supply --format=dotenv | npx wrangler secret bulk`
2. The domain is done. The nameservers moved from GoDaddy to Cloudflare on Saturday night, each Worker has a custom domain in its wrangler.jsonc, and `SUPPLY_URL` and `HUB_URL` are the domain. One thing to know if it is ever set up again: Cloudflare copies the old host's records when a domain is added, and it will not attach a Worker to a name that already has records (error 100117). Delete the copied A records for that name in the dashboard, then deploy.

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
* Naming a taught part needs `GEMINI_API_KEY` on the hub. Without it the screen says so and a typed name works.
