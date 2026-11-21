# Flows

Each step names the screen and the data. Shapes are in contracts/.

## Demo flow

1. Shelf. The TV shows `/`. Snapshot: 4 products, wood screws at 6 of 12, reorder point 4. Olive plate, the word "Stocked". Sentence: "Watching the board. Every part is above its reorder point."
2. Shelf. A judge reaches in. Node posts a Reach start: that zone's outline and handles turn lime until the reach ends.
3. Shelf. The judge takes 2 boxes. Reach end. Node (level 2) or eye posts the Count: 4. Hub writes a PickEvent, recomputes the Policy, broadcasts count, pick, policy. The figure cuts from 6 to 4, two squares go hollow, the plate cuts from olive to wine and the word becomes "Reorder". Sentence: "2 boxes of wood screws taken. 4 left, about 7 days of cover. Getting prices for 8 boxes."
4. Hub opens Order o-1 (pricing), PO RU-1042, sends a market job and a cart job to the buyer. The Shelf keeps the screen for 2.5 seconds so the drop is seen, then `screen` becomes shop.
5. Shop. Three frames settle in with blinking handles, then hold live iframes as each Run gets its streamingUrl. The newest step shows above each frame.
6. Shop. Market runs finish: a result above each frame and its handles stop blinking. The cart run reaches the review page: "8 boxes in the cart. $67.71 with tax." Buyer posts IngestCartBody. Order becomes awaiting_approval. `screen` becomes order.
7. Order. Paper plate, the word "8 boxes", the part in the frame. "$67.71" total with tax, $7.49 a box, arrives Tuesday, from Offcut Supply. Reason and market note below. "Press the button to approve."
8. The judge presses the wooden button. Node posts approve by button. Order becomes approved; hub sends the place job.
9. Order. The plate cuts to wine, the word is "Placing", and the frame holds the live browser: "Placing the order at Offcut Supply." The agent enters the PO number and places the order. Buyer posts IngestPlacedBody. Order becomes placed: the plate cuts to olive, the word is "Ordered", the figure is the confirmation number OC-58213. "Ordered. Arrives Tuesday."
10. Offcut's webhook: order.confirmed, then order.shipped 20 seconds later. Order becomes shipped.
11. After 20 seconds on placed, `screen` returns to shelf. Olive plate, the word "On the way". The wood screws row says "8 boxes on the way · arrives Tuesday".
12. Why (operator presses 4). The chart and the season control. Flip to Busy week: the reorder line rises.
13. Teach (operator presses 1, then puts a new part on the teach spot). Eye posts the crop. Overlay: "Looks like: Wood screws #8 x 2 in, box of 100." Confirm on the phone. "Counting it now."
14. Reset. Parts go back: counts rise, order o-1 becomes received. Operator presses Reset demo.

## QNX judge flow

1. Show the Pi, the C270 and the button. Operator page shows node level and "online".
2. Run `./judge_demo.sh` on the Pi over ssh; it prints the steps.
3. Kill vision. The page shows visionRestarts go up by one within a second. Press the button: it still answers.
4. Pull the network cable. Take a box. Nothing changes on the TV pocket count if the eye is also covered, or the eye shows it; the Pi's ledger gains a line and its queue shows 1.
5. Plug the cable back in. The queue drains to 0, the pick appears with source node, and if the count crossed the line while offline, the order opens with trigger node.

## Teach flow

1. Aux camera sees a new item on the teach spot, still for 1 second. Eye posts TeachBody.
2. Hub stores the crop, TeachState naming. The TV cuts to the Teach plate (paper, "New part") with the crop in a frame whose handles blink.
3. Hub asks Gemini to choose from Offcut's catalog. TeachState needs_confirm with a suggestion.
4. Phone `/m` shows the form. The person fixes the name if needed, picks the zone, taps Confirm.
5. Hub creates the Product and a starting Policy. Eye saves the crop as the visual prompt. Counting starts.
6. Failure: Gemini times out. TeachState failed. The phone form is empty but still works.

## Setup flow (operator, once)

1. Open `/ops`, enter the ops token.
2. Empty the board. Press "Capture empty board". On the Pi run `./capture_reference.sh`.
3. Drag a quad over each group of pockets, set rows and cols, pick or create the product. Save.
4. Fill the board. Check every count on Shelf matches what is there.
5. In the TinyFish dashboard create a profile, sign in to Offcut Supply in its setup browser, save it, and put the profile id in Infisical as TINYFISH_PROFILE_ID.
6. Run one order by hand from `/ops` so every kind of run has a recording for replay.

## Failure flows

| What fails | What the screen does |
| --- | --- |
| A market run is blocked | Its frame gets an alert tag and the reason shows above it. The order continues with the other quotes, or none |
| The cart run fails | A saved recording replays with the word Replay if one exists; otherwise the order is failed: "Could not fill the cart. Nothing was bought." |
| The place run fails | Order failed, same sentence. The operator can start it again |
| Hub unreachable from the TV | Alert tag: "Hub unreachable. Showing the last counts from 9:14." The word takes the text colour. Reconnects by itself |
| Camera unplugged | Shelf draws the board from pocket data with an alert tag saying so |
| Node offline | Alert tag: "Shelf node offline." The top tag reads "Counted by the eye". Approve from a phone |
| Buyer offline | Orders wait in pricing with the sentence "The buyer is offline." |
