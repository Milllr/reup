# SPEC

reup, Hack Western 13. Every session loads this page. Details live in docs/features.json, docs/UI.md, docs/FLOWS.md, docs/ARCHITECTURE.md and contracts/.

## Pitch

reup is an inventory employee: cameras watch the parts board, reup counts what is there, learns how fast each part gets used, and buys more on the live web before it runs out.

## Who it is for

A small shop or lab that keeps parts on hand. Today someone notices an empty box, forgets, and the job stops. This is everyday tracking of what a company uses. It is not theft prevention and nothing in the product should read that way.

## The 3 minute demo

Three judges, one at a time, at our table. No slides. A wooden parts board, two cameras, a Raspberry Pi on QNX, a wooden button, a TV.

1. See (0:00). The TV shows the live board with a count on every part.
2. Take (0:15). The judge takes two boxes of screws. The count drops in about a second and crosses the reorder point.
3. Shop (0:25). Live browser panes open. reup checks the price at two real retailers and fills a cart at Offcut Supply.
4. Decide (1:10). One order card: 8 boxes, the total, arrives Tuesday, one line of reason.
5. Approve (1:20). The judge presses the wooden button. reup places the order and the confirmation number appears.
6. Explain (1:50). One chart: usage, forecast, a reorder line that moves when the season switch is flipped.
7. Teach (2:15). A new part goes on the teach spot. reup names it from the store catalog and starts counting it.
8. For QNX judges. Pull the network cable, take a part: the Pi still records it and still calls for the order. Kill the vision process: it is back within a second and the ledger never stopped.

Reset between judges: put the parts back and press one key on the operator page.

Offcut Supply is a store we built so reup can finish a real checkout without spending money. The demo says so out loud. Price checks run on live retailers we do not control.

## End goals

* The whole loop works every time: see, count, decide, shop, approve, place, track, receive.
* A judge understands it in ten seconds without anyone talking.
* Every wait is something to watch. Every failure has a fallback, and the screen says when it is using one.

## Features

The full list with acceptance steps and tests is docs/features.json. Groups: counting (eye), shelf node (QNX), hub and reorder brain, purchasing (buyer), Offcut Supply store, screens (web), teaching, operator tools, demo safety.

## Quality bar

Every acceptance step built and unit tested, screens matching docs/ui/, loading, empty and error states handled, nothing rough on the demo path. Do not cut corners to save time.

## Words

Plain facts with numbers, no hype, no exclamation marks, no emoji: "4 left. 7 days of cover. Ordering 8 boxes. Waiting for a yes." Never use an em dash or an en dash in any copy, label, comment or doc. Use a period, a comma or a colon.

## Out of scope

* Real payments, card numbers or real orders at any real retailer. Retailer runs read prices only.
* Accounts and sign in for reup itself. One shared demo space.
* Barcodes, RFID, scales.
* A native mobile app. The phone view is a web page.
* The Arduino UNO Q, the sound sensor and the speaker.

## Tracks we target

* Overall: innovation, technical complexity, completeness, design.
* Hire Your First AI Employee by TinyFish: a browser job done start to finish on the live web. A demo post on X or LinkedIn tagging TinyFish is required.
* Best Use of QNX: an embedded AI system on QNX using a QNX open source AI module, shown on the hardware, where reliability matters.
* Also entered: Best Hardware Prototype by PCBWay, MLH Best Use of Gemini API.

## Open questions

* Which two live retailers pass the supplier test. Buyer lane owner decides after the playground runs.
* Whether Python with sqlite3 and ssl is on the QNX image. Node lane owner checks on the Pi; the answer picks Python or C++ for the guard.
* The store's final name (Offcut Supply is the working name) and the logo. Miller picks.
