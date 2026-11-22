# UI

Agents match this and the mockups in docs/ui/ exactly. docs/ui/specimen.css is the source: copy it and docs/ui/fonts/ into apps/web/src/styles/ unchanged and build on its classes.

## Direction

Specimen. Miller picked the system in the third video of anagram's "Design recap" post as the exact design system for reup: https://x.com/anagramclub/status/2123754233723863164

A screen is one flat colour, one enormous word, and one framed thing to look at, shown the way a design tool shows a selected object. In reup the specimens are the parts board, the live browser and the order.

We take the system: plates, the word, the frame and its handles, tags, type, grain, motion. We never take anagram's or their clients' words, products, pictures, names or logos.

## The five parts

Every screen is built from these and nothing else.

1. Plate. One flat colour over the whole screen, with fine grain. The plate is the state: when the state changes, the plate cuts to another colour.
2. Word. One per plate, as wide as the plate, running off the top or the bottom edge, behind everything else. It says the state in one word.
3. Frame. A flat box with four square handles at its corners, as if selected. It holds the one thing to look at. That thing, or a tag, always crosses the frame's edge. The frame overlaps the word.
4. Tags. Small pills in mono capitals. They say who did the work ("Counted by the shelf node on QNX") or what a thing is ("Price check · Retailer A"). The only rounded shape.
5. Type. Figures, names and short sentences set straight on the plate. No boxes behind them.

## Plates

| Plate | Ground | Word | Frame | Handles | Text | Tag | Word sits | Means |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `olive` | `#5A5F1E` | lime `#E0EF3D` | cream `#F7FBE2` | white | cream | blue `#BFEBF3` | bottom | All is well, or it is done |
| `wine` | `#6D1229` | orange `#FA4B05` | stone `#80867C` | white | cream | cream `#FBFCE5` | bottom | reup is working on a shortage, or something stopped |
| `paper` | `#EFF0E8` | charcoal `#40373A` | moss `#59573F` | orange | ink `#1E1A19` | pink `#E5A8E2` | top | A person reads or decides |

The colours are measured from the reference frames. There are no others, apart from what is inside a frame (the camera feed, a web page, a product picture).

## The word for each moment

| Moment | Plate | Word |
| --- | --- | --- |
| Shelf, every part above its reorder point | olive | Stocked |
| Shelf, a part at or under its reorder point with no order placed yet | wine | Reorder |
| Shelf, every low part has a placed order | olive | On the way |
| Shop | wine | Shopping |
| Order, awaiting_approval | paper | The order itself: "8 boxes" (units, then the first word of Product.unit in the plural; "each" reads "2 units") |
| Order, approved and placing | wine | Placing |
| Order, placed, shipped, received | olive | Ordered |
| Order, failed | wine | Stopped |
| Order, cancelled | paper | Cancelled |
| Why | paper | Forecast |
| Teach, until it is confirmed | paper | New part |
| Teach, for 3 seconds after confirm | olive | Counting |
| No parts yet | olive | Empty |

While the hub is unreachable the plate and the word stay as they were and the word takes the text colour (`.word.quiet`).

## Tokens

| Token | Value |
| --- | --- |
| Sans | Inter Tight (variable, bundled in docs/ui/fonts, OFL). Weights 500 and 600 only |
| Mono | Geist Mono (variable, bundled, OFL). Weight 500, capitals, tracking 0.04em |
| Word | weight 600, line height 0.78, tracking minus 0.055em. The Word component sets `--size` so the word spans the plate less 28 a side, never under 260 or over 540 |
| TV type | figure 112, mid figure 68, name 26 weight 600, copy 26 weight 500, small copy 20, tag and meta 15 mono |
| Phone type | figure 60, mid figure 38, name 19, copy 18, small copy 16, tag and meta 12 |
| Figures | tabular everywhere |
| Stage | The TV is drawn at 1920 by 1080 and scaled to fit the window (`.stage`, `--fit`). Sizes in the mockups are TV pixels |
| Handles | 22 square on a frame, 12 on a zone, centred on the corner. Never rounded |
| Mat | A camera feed, a web page or a chart sits 18 inside its frame, so the frame colour shows around it |
| Corners | Square, always. Only tags are round |
| Grain | One noise layer over the plate at 14 percent, multiplied (`.plate::after`) |
| Motion | Plate change: a cut, 120ms. Word colour: 240ms linear. A new frame settles from 2.5 degrees and 96 percent over 800ms. A product picture turns slowly, 900ms per move. Handles blink (900ms, two steps) while a frame is not settled: a pane still loading, an order waiting for a yes. Press: scale 0.98 over 120ms. Nothing bounces, nothing fades in. `prefers-reduced-motion`: cuts only |

## Rules

1. One plate, one word, per screen. Never two words, never a second ground colour.
2. Flat colour only. No gradient, shadow, blur, glow, border radius, outline card or divider line. Space separates things.
3. The word is behind everything and is cut by the edge it sits on. The main frame overlaps it by 40 to 90. A bottom word with letters that hang below the line (g, j, p, q, y) sits a little higher (`.word.tails`), so "On the way" does not read as "On the wav".
4. Something always crosses a frame's edge: its tag on the top edge, a zone tag, or the product picture.
5. Orange is the only alarm. It is the word on wine, the handles on paper, the alert tag, a low zone's outline and a low figure on wine. Never orange type on olive or paper: use an alert tag there.
6. A colour is never the only cue. A word or a tag always says it too.
7. Tags are mono capitals and say who did what, or what a thing is. Sentences are sans and say what happened, with numbers.
8. Stock is drawn as squares, one per unit, hollow where a unit was taken (`.units`). The same square as a handle.
9. Text contrast is at least 4.5 to 1. Cream on stone is for figures only.
10. Copy is plain facts with numbers. No exclamation marks. No em dashes or en dashes. No emoji, no icons.
11. The logo is brand/reup-up.svg (icon) and brand/reup-wordmark.svg. One colour: cream on olive and wine, ink on paper. Top left on olive and wine, bottom left on paper.

## Shared components

All in apps/web/src/components, styled only with specimen.css classes.

| Component | Class | What |
| --- | --- | --- |
| Stage | `.stage` | The 1920 by 1080 box, scaled to the window by setting `--fit` on resize. Phones do not use it |
| Plate | `.plate.olive`, `.plate.wine`, `.plate.paper` | The ground. Sets every colour role for what is inside it |
| Word | `.word.bottom`, `.word.top`, `.word.quiet`, `.word.tails` | Measures its text and sets `--size` (TV) or `--w` (phone band) so it spans the plate |
| Frame | `.frame`, `.frame.settle`, `.frame.waiting`, four `<i class="h tl">` handles | The specimen box. Content goes in `.fill` or `.fill.mat`; a `.tag` child sits on its top edge |
| Subject | `.subject` | The drawn box (PartBox) or a product picture, placed over a frame so it crosses the edge |
| Zone | `.zone`, `.zone.low`, `.zone.reach` | A selection on the feed, placed from the zone's quad, with handles and a tag |
| Tag | `.tag`, `.tag.blue`, `.tag.pink`, `.tag.cream`, `.tag.alert`, `.tag.center` | The pill. Without a modifier it takes the plate's tag colour |
| Figure | `.figure`, `.figure.mid`, `.low` | A number or a short fact. Changes by cutting to the new value |
| Name, Meta, Copy | `.name`, `.meta`, `.copy`, `.copy.small` | A product name, a mono caption, a sentence |
| Units | `.units`, `<i>`, `<i class="gone">` | One square per unit of capacity |
| Button | `.btn`, `.btn.quiet`, `.seg` | Real `<button>`. A flat rectangle in the text colour. `.seg` joins buttons into one control |
| Field | `.field` | Label in `.meta`, a square input with a 2px line |
| Chart | `.chart` with `.bar`, `.stock`, `.band`, `.rop`, `.today` | SVG inside a frame |

## Screens

The TV shows one stage at `/` and moves between screens by itself from `snapshot.screen`. Nobody clicks during the demo.

| Screen | Route | Mockup | Plate | Shows |
| --- | --- | --- | --- | --- |
| Shelf | `/` when screen is `shelf` | docs/ui/shelf.html (add `?low` for the wine state) | olive or wine | The live feed in the frame with a zone selection per part, the index of counts, one sentence |
| Shop | `/` when screen is `shop` | docs/ui/shop.html | wine | One frame per run with the live browser, its result above it, the part being bought |
| Order | `/` when screen is `order` | docs/ui/order.html | by order state | The part in a frame, the total, the arrival day, one line that says how to say yes |
| Why | `/` when screen is `why` | docs/ui/why.html | paper | The chart in a frame, the reorder sentence, the season control |
| Teach | replaces Shelf while `teach` is not null | described below | paper, then olive | The crop in a frame, the suggested name and store match |
| Phone | `/m` | docs/ui/phone.html | bands | Approve, name a new part, counts |
| Ops | `/ops` | described below | paper | Zone editor, health, run log, reset, season, replay |
| Analytics | `/analytics` | described below | paper | Every part: 30 days behind, today, 60 days ahead, and the orders placed |

Shelf. Wordmark top left, the tag "Counted by the shelf node on QNX" top centre (no tag when the node is below level 2 and the eye counts), the time top right in `.meta`, left of the menu. The frame is 1150 by 700 at 96, 118 and holds the feed on a mat. Each zone is a `.zone` placed from its quad with a cream tag: "Wood screws  6 of 12", the name, two spaces, the count, no dot. The index on the right is one row per product: figure, name, units, meta ("11 days of cover"), then one sentence. When a part is at or under its reorder point and has no placed order, the plate cuts to wine, the word becomes "Reorder", that zone turns `.low` with an alert tag, and its figure turns `.low`. Once its order is placed the plate is olive again, the word is "On the way", and the row's meta reads "8 boxes on the way · arrives Tuesday". A reach turns its zone `.reach` until it ends.

Shop. The tag reads "Shopped by TinyFish on the live web". One sentence at 34 top left, the part being bought top right. Three frames, 544 by 400, at 450 from the top. Each has a tag on its top edge ("Price check · Retailer A", "Your supplier · Offcut Supply") and its result above it as a mid figure with a meta line. A frame is `.waiting` until its run ends. A failed run gets an alert tag ("Blocked · Retailer B") and the figure "No price". A replayed run's tag ends with "· replay".

Order. See the mockup and the list of states at the bottom of its file. The frame is 460 by 600. Across it sits the drawn box from the mockup (one inline SVG component, PartBox), turned 9 degrees, with the product's name and unit on its label, so it works for any part. If Product.imageUrl is set and has no background, that picture replaces the box. Left: the total as a figure and the arrival day as a mid figure. Right: one button, "Approve to place order" (`.btn.yes`), on any screen that can say yes, and nothing else. Enter does the same. With the shelf node connected one mid figure above it reads "Press the wooden button to place the order." A screen that cannot say yes reads "Say yes from a phone to place the order." There is no reason line, no price note, no small print and no tag. Once the order is placed the PO number is top right, and an X (`.close`) beside the menu goes back to the main view.

Why. The frame is 1100 by 580 and holds the chart: boxes used per day as bars, stock as a stepped line, the next 7 days as a band, the reorder point as an orange line that moves within 300ms, today as a dotted line, and a date under the axis every week counted from today ("Nov 14", "Nov 21", "Nov 28"). Right: the reorder point as a figure, the policy reason, the season control (Slow, Normal, Busy) as a `.seg`, and Ask reup as one field with no hint under it. Nothing else: no line that explains the chart and no tag about sample days. While the history is being read the frame says "Reading 30 days of counts."

Teach. Paper plate, word "New part". A frame holds the picture of the part, `.waiting` until confirmed. The frame takes the picture's own shape, so the whole picture shows: it is never cut to fit. Right: "Looks like wood screws #8 x 2 in." as a mid figure, the meta line "Box of 100 · Offcut OC-1008-200 · fairly sure" (Sure, Fairly sure, Not sure), and small copy "Confirm on a phone or the operator page." Bottom right tag: "Named by Gemini from the store catalog", and nothing sits under it. On confirm the plate cuts to olive with the word "Counting" for 3 seconds, then Shelf returns.

Shelf, a part in the wrong box. Its outline on the feed is orange and thicker, and the alert tag reads "1 from hex bolts is in the washers box. Not counted." The count in the index is what is at home.

Teach, on a screen that can say yes. Left: a 1040 by 601 frame tagged "Where it sits" holds the board's picture with every box on it. The new part's box is orange, tagged "New part", and starts on the teach spot. The station's boxes are cream. Every box is dragged by its middle and fitted by its corners, and nothing is saved until Confirm. Right: the picture in a frame of at most 320 by 320, the sentence at its foot with how sure reup is under it in mono, then the form: Name, then "One unit is" and "Offcut SKU" side by side, then Confirm and "Not a part" side by side. The form ends above the bottom right tag. There is no line about the teach spot and no list of places.

Phone. Plates stack as bands (`.plate.band`), each with its own word fitted to the band: the order waiting for a yes (paper), a new part to confirm (paper), then the counts (olive, or wine when a part is low). Buttons are full width.

Ops. Paper plate, the word "Operator", two columns of type on the plate. Zone editor: the board in a moss frame, each zone a `.zone` whose handles drag, a rows by cols stepper for pocket zones, and three buttons, "Capture empty board", "Capture full board" and "Set camera position". Health as meta lines: each camera (online, fps), the node (level, last seen, queued events, vision restarts), the buyer (connected), the TinyFish balance if known. The run log is a table in mono with no rules. Buttons: Reset demo, Replay last good run (per kind), Cancel order.

Analytics. Paper plate, the word "Analytics", a page that scrolls, for a laptop. Type starts under the word. No tag over the figures unless something is wrong. Six figures: on the board, used today, at the reorder point, least cover, orders in the next 60 days, ordered so far. Then Items (`.items`): a table with no rules, one row an item, with its name and unit, the store SKU, "Camera · Wood screws" or "By hand", a count field with Set, and Edit and Remove as quiet buttons. Edit turns the row into one line of fields. Remove needs a second press. Under the table, "Add an item" is one line of fields: Bought as, Name, Unit, Counted, On the shelf now. What the hub answers shows in a tag, blue for yes and orange for no. With no key the table is read only. Then one moss frame for each part with one chart: the stepped line is what the board held over 30 days, the dotted line is what reup expects over the next 60, an orange square is a day reup orders and a cream square is the delivery landing, the orange line is the reorder point. Pointing at a day says what it held. Under each frame one sentence says what happens next. Then columns of units used each day and by the hour today, ranked bars of what moves most, the last moves as lines of type, and two tables with no rules: the orders reup placed and every number. One colour for every series: a chart never needs a legend to tell two lines apart.

Menu. Three cream bars on an ink square in the top right corner of every page (`.menu`). It opens a flat ink panel: Board, Analytics, Operator, Phone, with an orange square on the page you are on. On the board it also lists "This screen shows": Auto, Shelf, Shop, Order, Why. Picking a screen holds this screen on it, and only this screen, until the hub moves to another screen by itself or Auto is picked. On a board that can change things it ends with "The board": "Move the ledge boxes" and "Name what is on the teach spot". Escape or a click anywhere else shuts it.

Moving the ledge boxes. The Shelf with every corner of every box as an orange square handle (`.corner`, 26px) and the box's true shape drawn in orange. A corner is dragged to fit the box to its ledge, the middle moves the whole box. In place of the sentence: one line of hint, "Save the boxes" (`.btn`) and "Cancel" (`.btn.quiet`). Escape is Cancel.

States every screen handles: loading (the frame is `.waiting` and empty, the word is `.quiet`), empty (olive, word "Empty", one sentence: "No parts yet. Put one on the teach spot."), offline (alert tag: "Hub unreachable. Showing the last counts from 9:14."), error (alert tag with the plain reason).

## Offcut Supply

A different company, so a different look. Do not use specimen.css there.

White page, system font stack, dark grey text `#1F2328`, one blue `#0B5FFF` for links and buttons, 6px radius, thin grey borders `#D0D7DE`. Header: "Offcut Supply" in bold text, a search box, Sign in, Cart (n). A footer on every page: "Offcut Supply is a demo store built for Hack Western 13. Nothing here is for sale." It should look like a small trade supplier's site: dense, useful, a little dated. It has a cookie notice on first visit, because real stores do and the agent should handle one.
