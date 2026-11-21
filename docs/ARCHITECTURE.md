# Architecture

Read on demand. It is not loaded into every session.

## One picture

```
 parts board
   |  Facecam, C920            C270
   v                            v
 Eye (laptop, Python)        Shelf node (Pi 5, QNX)
   | counts, teach crops        | picks, pocket counts, button, reorder calls
   +-------------+--------------+
                 v
        Hub (Cloudflare Worker + Durable Object + D1)
          live state, history, reorder brain, Gemini naming
                 |  jobs                         ^ runs, quotes, results
                 v                               |
        Buyer (laptop, Node, TinyFish SDK) ------+
                 |  TinyFish cloud browsers
                 v
   live retailers (prices only)      Offcut Supply (our store: cart, order)
                                          | order webhook
                                          v
                                         Hub
                 Hub --WebSocket--> Web (TV, phones, operator)
   Eye --MJPEG on the local network--> Web on the TV (the video never leaves the laptop)
```

## Stack

| Part | Runs on | Built with | Why |
| --- | --- | --- | --- |
| Web | Browser, served by the hub | React 19, Vite, TypeScript, plain CSS from docs/ui/specimen.css | One origin, no CORS, and the mockup CSS is the app CSS |
| Hub | Cloudflare | Worker with Hono, one Durable Object (`Room`) for live state and WebSockets, D1 for history | One public address every machine dials out to, so nothing has to find anything on the venue network |
| Brain | Inside the hub | `packages/brain`, pure TypeScript | Reorder math with no I/O, so it is fully unit tested |
| Supply | Cloudflare, its own Worker | Hono with server rendered HTML, D1 | A real, plain web store that an agent has to browse like a person |
| Buyer | Laptop | Node 22, TypeScript, `@tiny-fish/sdk`, `ws` | TinyFish reports run progress over one long SSE connection, which a plain process holds without tricks |
| Eye | Laptop | Python 3.12+, numpy, OpenCV, Ultralytics YOLOE-26, the standard library http.server for the local MJPEG stream | The detector needs a GPU or a fast CPU, and the video should stay local |
| Shelf node | Raspberry Pi 5, QNX 8 | C++ with TFLite and the QNX sensor framework (from github.com/qnx/QNX-AI-workshop), plus a guard in Python if the image has it, else C++ | Required for the QNX prize, and it is the part that keeps working when everything else is down |
| Naming | Hub calls the Gemini API | One image plus the Offcut catalog as a closed list | A model that names once and never counts |
| Secrets | Infisical, pushed to Wrangler | | No keys in the repo |

Package manager: npm workspaces. Tests: vitest for TypeScript, pytest for Python. CI runs `npm run check`.

## Components and data flow

1. The eye reads frames, counts every zone, waits for the board to be still for half a second, and posts changed counts to `POST /ingest/counts`.
2. The shelf node watches the same board with its own camera. A hand entering and leaving is a reach. After each reach it compares every pocket with its empty reference and posts picks to `POST /ingest/picks`. It keeps a ledger on the Pi and replays anything unsent when the network returns.
3. The hub's Durable Object holds the live `Snapshot` (contracts/src/schema.ts). Every change is broadcast to every WebSocket as a `ServerMessage` (contracts/src/events.ts) and written to D1.
4. On every count the brain recomputes the product's policy. If the count is at or under the reorder point and the product has no open order, the hub opens an order and sends jobs to the buyer over its WebSocket.
5. The buyer runs TinyFish: a market check on the live retailers (prices only) and a cart run at Offcut Supply. It streams run progress and the live preview URL back to the hub with `POST /ingest/runs`.
6. The order waits for a yes from the wooden button (through the node) or a phone. Then the buyer runs the place job, and Offcut Supply's webhook confirms and later ships the order.
7. When the count for that product rises, the order is marked received.

Count of record: for pocket zones the node's count wins when the node is online and at level 2 or higher; otherwise the eye's count is used. Open zones always use the eye. If the two disagree for more than 3 seconds the operator page shows it.

Offline rule: the node keeps a copy of each product's reorder point. If it cannot reach the hub and a count crosses the line, it records a reorder call and sends it with `POST /ingest/reorder` when the network returns.

## Environments

| Thing | Local | Deployed |
| --- | --- | --- |
| Hub and web | `wrangler dev` on the worktree PORT | https://wheredidallmyinventorygo.wtf (workers.dev URL until DNS is live) |
| Supply | `wrangler dev` on PORT + 1 | https://offcut.wheredidallmyinventorygo.wtf (workers.dev URL until DNS is live) |
| Eye stream | http://localhost:8089/stream/board.mjpg (the TV's browser runs on the eye's laptop) | local only |
| Node | the Pi on the venue or hotspot network | local only |

TinyFish runs in the cloud, so Offcut Supply must be deployed for cart runs. It cannot reach localhost.

## Lanes

Must match hw/lanes.json. Lanes are areas of the code, not people.

| Lane | Folders | Builds |
| --- | --- | --- |
| web | apps/web | Every reup screen |
| hub | apps/hub, packages/brain | Routes, the Room, D1, the brain, Gemini naming, webhooks |
| supply | apps/supply | Offcut Supply |
| buyer | services/buyer | TinyFish jobs |
| eye | services/eye | Counting, teaching crops, the local stream |
| node | edge/qnx | The shelf node |
| integrator | contracts, brand, docs, hw, CI | Contracts, mockups, deploy config |
