# Buyer

A Node process on the laptop. It holds one WebSocket to the hub, and for each job the hub sends it runs a TinyFish agent in a real browser: a price check at each live retailer, a cart at Offcut Supply, and after a yes, the order.

## Run it

* Real, with TinyFish: `infisical run -- npm run start -w services/buyer`
* Development stand in, no TinyFish and no credits: `npm run start:local -w services/buyer`
* Tests: `npm run test -w services/buyer`

The stand in drives Offcut Supply's own pages over plain HTTP and makes up retailer prices from the store catalog. Runs it makes are marked `engine: local` and the Shop screen says so. It is for building the loop on one laptop, never for the demo.

## Environment

| Name | What | Default |
| --- | --- | --- |
| HUB_URL | The hub | http://localhost:3000 |
| DEVICE_TOKEN | Bearer token for the hub's ingest routes and the buyer socket | dev-device-token |
| SUPPLY_URL | Offcut Supply | http://localhost:3001 |
| TINYFISH_API_KEY | From Infisical | none, required unless BUYER_ENGINE=local |
| TINYFISH_PROFILE_ID | A saved browser profile that is signed in to Offcut Supply | none |
| OFFCUT_EMAIL, OFFCUT_PASSWORD | The shop account, used only when there is no profile | shop@reup.test, the store's own development password |
| BUYER_ENGINE | `tinyfish` or `local` | tinyfish |
| TIME_ZONE | For delivery dates | America/Toronto |

At startup the buyer prints whether each secret is set. It never prints a value.

## Rules it keeps

* Retailers are for prices only. A cart or a place job for a supplier that is not kind `account` is refused and logged.
* A place job runs only when the hub sends one, and the hub sends one only after a person said yes.
* A run that ends without a confirmation number is a failure, never a guess.
* Every good run is saved to `recordings/<kind>-<supplier>.json` (gitignored). A failed price check or cart falls back to the last good recording, marked Replay on the screen. A failed place run does not: only the operator's replay switch plays a recording of placing an order.
* `output_schema` uses only the keywords TinyFish accepts (no `description`, no `additionalProperties`, `nullable: true` for nulls). A test checks every schema, because TinyFish answers 400 before the run starts.

## Suppliers

`suppliers.json` lists the live retailers. The hub seeds its supplier list from the entries with `enabled: true`, so this is the one file to edit. `tested` is false until a retailer passes the supplier test in the TinyFish playground: a search for the phrase returns a price without a captcha, three times in a row.

## Where things are

| File | What |
| --- | --- |
| src/hub.ts | The socket, reconnect with backoff, missed jobs, posting results |
| src/runner.ts | One run: mirror to the hub, save, replay, fall back |
| src/agent.ts | The seam to TinyFish, with polling when the stream drops |
| src/market, src/cart, src/place | The goal, the schema, the checks and the result mapping for each job |
| src/jobs.ts | The job loop |
| src/dev/local-agent.ts | The development stand in |
