# Contracts

Every shape that crosses a lane lives here, and only here. Both sides import it; nobody redeclares it. Only the integrator lane edits this folder; everyone else proposes changes with /contract.

Written Sat Nov 21 at kickoff. Frozen: add fields, do not rename or remove them.

## Files

* `src/schema.ts`: the things. Zone, Product, Count, PickEvent, Reach, Policy, Supplier, Quote, Run, Order, NodeStatus, Camera, TeachState, Snapshot, Catalog
* `src/events.ts`: WebSocket messages from the hub (`ServerMessage`) and the buyer's work (`Job`)
* `src/api.ts`: the body and the result of every hub route, and `ROUTES`
* `api.md`: the routes as a table, auth, errors, the eye's local routes
* `mocks/`: one sample payload per shape. `snapshot.json` is the demo at the moment shopping starts. `catalog.json` is also Offcut Supply's seed data
* `test/mocks.test.ts`: every mock validates against its schema

## How to use it

* TypeScript: `import { Snapshot, type Order } from '@reup/contracts'`. Parse anything that crosses the network with the zod schema, at the edge, once.
* Python (eye): `services/eye/reup_eye/contracts.py` mirrors the few shapes the eye sends. Its tests load the same mocks, so drift fails CI.
* The node's guard is standard library only. Its tests compare what it sends with the mocks key for key.
* Build against `mocks/` when the other side is not merged yet. The web app runs from them with `?mock=1`.

## Rules

* Add fields, do not rename or remove them. A breaking change needs a contract issue and a heads up to the whole team.
* Every shape has a mock in `mocks/` that validates against its schema.
* Names here are the names everywhere: UI labels can differ, field names cannot.
* Units are boxes or bags, never single screws. Money is CAD dollars as a number. Times are ISO 8601 with an offset.
