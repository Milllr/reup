# Hub API

The readable version of contracts/src/api.ts and contracts/src/events.ts. If this page and the code disagree, the code wins and this page gets fixed.

Base URL: `HUB_URL`. JSON in and out. Times are ISO 8601 with an offset. Money is CAD dollars as a number.

## Auth

| Token | Sent as | Used by | Routes |
| --- | --- | --- | --- |
| DEVICE_TOKEN | `Authorization: Bearer` | eye, node, buyer | `/ingest/*`, `/api/jobs`, `/api/teach`, approve by button |
| OPS_TOKEN | `Authorization: Bearer` | operator page | `/api/zones`, `/api/demo/*`, manual order, cancel |
| APPROVE_KEY | `Authorization: Bearer` | phones (from the QR link `?k=`), and a TV or laptop opened with `?k=` | approve by phone or by keyboard, teach confirm and cancel |
| SUPPLY_WEBHOOK_SECRET | `X-Offcut-Secret` | Offcut Supply | `/hooks/supply` |

Reading state needs no token: `/live` for screens, `/api/state`, history, and a teach crop at `/api/teach/:id/crop.jpg`. The buyer's socket is the exception: `/live?role=buyer&token=DEVICE_TOKEN`, because only the buyer is sent jobs.

## Errors

Every error is `ApiError`: `{ ok: false, code, message }` with status 400 bad_request (body failed its schema; message names the field), 401 unauthorized, 404 not_found, 409 conflict (wrong state), 502 upstream_failed (Gemini or the store).

## Routes

| Method | Path | Body | Returns | Mock |
| --- | --- | --- | --- | --- |
| GET | /live?role=screen, ops or buyer | WebSocket | ServerMessage stream, snapshot first | server-messages.json |
| GET | /api/state | | Snapshot | snapshot.json |
| GET | /api/products/:id/history | | HistoryResult | history.json |
| GET | /api/jobs | | JobsResult | jobs.json |
| POST | /ingest/counts | IngestCountsBody (counts may be empty when cameras is sent) | Ok | ingest-counts.json |
| POST | /ingest/picks | IngestPicksBody | IngestPicksResult | ingest-picks.json |
| POST | /ingest/reaches | IngestReachesBody | Ok | ingest-reaches.json |
| POST | /ingest/node | IngestNodeBody | IngestNodeResult | ingest-node.json, ingest-node-result.json |
| POST | /ingest/reorder | IngestReorderBody | Ok | ingest-reorder.json |
| POST | /ingest/runs | IngestRunsBody | Ok | run.json |
| POST | /ingest/quotes | IngestQuotesBody | Ok | quote.json |
| POST | /ingest/cart | IngestCartBody | Ok | ingest-cart.json |
| POST | /ingest/placed | IngestPlacedBody | Ok | ingest-placed.json |
| POST | /api/teach | TeachBody | TeachState | teach.json |
| POST | /api/teach/:id/confirm | TeachConfirmBody | Product | teach-confirm.json |
| POST | /api/teach/:id/cancel | | Ok | |
| POST | /api/orders | ManualOrderBody | Order | order.json |
| POST | /api/orders/:id/approve | ApproveBody | Order | order-placed.json |
| POST | /api/orders/:id/cancel | | Order | |
| PUT | /api/zones | ZonesBody | Ok | |
| PUT | /api/board | BoardBody | Snapshot | board.json |
| POST | /api/demo/season | Season | Ok | |
| POST | /api/demo/reset | | Snapshot | |
| POST | /api/demo/screen | ScreenBody | Ok | |
| POST | /api/demo/replay | ReplayBody | Ok | |
| POST | /hooks/supply | SupplyWebhookBody | Ok | supply-webhook.json |

## Order states

`pricing` to `carting` to `awaiting_approval` to `approved` to `placing` to `placed` to `shipped` to `received`. Any state before `placed` can go to `failed` or `cancelled`.

## The eye's local routes (not the hub)

On the laptop, port 8089, local network only. No contract package: they are small and only the web and the operator use them.

| Method | Path | Returns |
| --- | --- | --- |
| GET | /stream/:camera.mjpg | multipart MJPEG |
| GET | /outlines/:camera.json | `{ ts, items: [{ productId or null, points: [[x,y], ...] }] }`, normalized |
| GET | /debug/:camera.jpg | the frame with zones drawn |
| POST | /reference/:camera | captures the empty board; `{ ok: true }` |
| POST | /anchor/:camera | this is where the camera sits now: later pictures are lined up with this one; `{ ok: true }` |
| POST | /full/:camera | with the board full, learns the size of one unit in every open zone; `{ ok: true, zones: { zoneId: { units, cells } }, skipped: { zoneId: reason } }`. `?zoneId=n` when a zone holds n and not its part's capacity. 409 before the empty board is saved |
| POST | /prompt/:zoneId | saves the current frame as the example of that zone's part, for the detector. `?box=x0,y0,x1,y1` is one part in the frame, each from 0 to 1; `{ ok: true }` |

## Offcut Supply's machine routes

| Method | Path | Returns |
| --- | --- | --- |
| GET | /catalog.json | Catalog (catalog.json) |

Everything else on Offcut Supply is for browsers. reup shops there through TinyFish.
