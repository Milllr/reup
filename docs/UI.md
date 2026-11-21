# UI

Agents match this and the mockups in docs/ui/ exactly. The CSS in docs/ui/glass.css is the source: copy it into apps/web/src/styles/glass.css unchanged and build on its classes.

## Direction

Glass, from Miller's life design system: frosted panes over one green world, lit from above, with the plain words of a quiet analyst. It should feel like sunrise on wet grass seen through glass, not like a dashboard.

## Tokens

| Token | Value |
| --- | --- |
| World (page ground) | `linear-gradient(180deg,#D6F0EC 0%,#E9F8DA 14%,#B6E384 46%,#7BC247 78%,#3C8A33 100%)`, painted once on the root. No screen has its own background |
| Glass fill | `linear-gradient(180deg, rgba(255,255,255,0.80), rgba(241,250,236,0.74))` |
| Glass rim | 1px, white |
| Glass shadow | `0 8px 22px rgba(47,125,58,0.26)` (green, never grey) |
| Ink | `#16331C` primary, `#4C6B50` muted, `#7A9480` faint (placeholders only) |
| Leaf | `#43B02A`, text `#2C741C`. In stock, the main action |
| Sun | `#F4C430`, text `#7A6218`. At the reorder point, waiting on a person |
| Aqua | `#21B6C4`, text `#146F78`. reup is working |
| Clay | `#D4583F`, text `#AA4632`. Out of stock, failed |
| Font | Source Sans 3 (variable, weights 300 to 600), tabular figures everywhere |
| Type scale on the TV | hero count 76/76 weight 300, screen title 34 weight 600, sentence 26/34, card label 20 weight 600, body 22, caption 18 |
| Type scale on a phone | hero 44/48 weight 300, title 22 weight 600, body 16/22, caption 14 |
| Spacing step | 4px grid: 8, 12, 16, 24, 28, 40 |
| Radius | 8 chips, 12 buttons and inputs, 16 cards, 20 frames. Only droplets are round |
| Motion | Enter: fade and rise 8px over 240ms ease out. Press: scale 0.98 over 120ms. Counts roll to a new value in 380 to 700ms, cubic-bezier(0.16,1,0.3,1). Loading: a white sheen sweep, 1200ms. No bounce. `prefers-reduced-motion`: 120ms fades only |

## Rules

1. Words never sit on the video. The feed lives in its own glass frame; counts on the feed sit on solid chips.
2. Every colour means one thing (the table above), and a word always says it too. Colour is never the only cue.
3. Stock is drawn as dew drops: one drop per unit, an empty ring where a unit was taken.
4. One light direction: from above. Gloss at the top of panes, shadows below.
5. Text contrast is at least 4.5 to 1 on glass. Use the text variant of an accent for words, the plain accent for fills.
6. No emoji, no stock icons, no purple, no cards inside cards, no dark mode.
7. Copy is plain facts with numbers. No exclamation marks. No em dashes or en dashes.
8. The logo is brand/reup-up.svg (icon) and brand/reup-wordmark.svg. One colour, always the colour of the text around it.

## Shared components

All in apps/web/src/components, styled only with glass.css classes.

| Component | Class | What |
| --- | --- | --- |
| World | `.world` | Root wrapper: gradient, sun bloom, two soft bokeh blobs |
| Pane | `.glass`, `.glass.frame`, `.glass.sun`, `.glass.aqua`, `.glass.clay` | The frosted pane. The modifier tints the rim only |
| Chip | `.chip`, `.chip.sun`, `.chip.aqua`, `.chip.clay` | Small solid label: status, count on the feed |
| Drops | `.drops`, `.drop`, `.drop.empty`, `.drop.sun` | One drop per unit |
| Count | `.count` | The hero number, rolls when it changes |
| ProductCard | `.glass` + parts | Label, count, drops, "of N, reorder at M", days of cover, one status line |
| StatusBar | `.glass.bar` | One sentence about what reup is doing, with a drop in the state colour |
| Button | `.btn`, `.btn.primary`, `.btn.quiet` | Real `<button>`. Primary is leaf with white text |
| Pane frame for a browser | `.glass.frame` + `.pane-head` | Supplier name, one line of progress, the live iframe |
| Feed | `.feed` | `<img>` of the MJPEG stream, zone outlines as an SVG overlay, count chips |
| Chart | `.chart` | SVG: used per day (bars), stock (line), forecast band, reorder line in sun |

## Screens

The TV shows one stage at `/` and moves between screens by itself from `snapshot.screen`. Nobody clicks during the demo.

| Screen | Route | Mockup | Shows |
| --- | --- | --- | --- |
| Shelf | `/` when screen is `shelf` | docs/ui/shelf.html | Live feed with zone outlines and count chips, product cards, the status bar |
| Shop | `/` when screen is `shop` | docs/ui/shop.html | Three live browser panes (two retailers, Offcut), a result line under each as it lands |
| Order | `/` when screen is `order` | docs/ui/order.html | One order card, the market check line, "Press the button to approve", then the confirmation |
| Why | `/` when screen is `why` | described below | One chart per focused product, the reorder sentence, the season switch |
| Teach | overlay on Shelf when a teach is active | described below | The crop, the suggested name and store match, "Confirm on a phone" |
| Phone | `/m` | docs/ui/phone.html | Counts list, a pending order with Approve, teach confirm |
| Ops | `/ops` | described below | Zone editor, camera and node health, run log, reset, season, replay switches |

Why: left, a glass frame with the chart (30 days of sample or real history, 7 days of forecast as a band, the reorder point as a sun line, today marked). Right, one glass card: the product, "Uses about 2.1 a day. Delivery takes 3 days. Reorder at 4.", and a segmented control for season (Normal, Busy week, Exam week). Changing it moves the line within 300ms. If history is seeded, a chip says "Sample history".

Teach: a glass card centred over the dimmed feed. Left, the crop. Right, "Looks like: Wood screws #8 x 2 in, box of 100", the Offcut SKU, a confidence word (Sure, Fairly sure, Not sure), and "Confirm on a phone or the operator page". After confirm: "Counting it now."

Ops: plain glass panes in two columns. Zone editor: the board frame with draggable quads and a rows by cols stepper for pocket zones, "Capture empty board" button. Health: each camera (online, fps), the node (level, last seen, queued events, vision restarts), the buyer (connected), TinyFish balance if known. Run log table. Buttons: Reset demo, Replay last good run (per kind), Cancel order.

States every screen handles: loading (sheen on the panes), empty (one sentence, for example "No parts yet. Put one on the teach spot."), offline ("Hub unreachable. Showing the last counts from 9:14."), error (clay chip with the plain reason).

## Offcut Supply

A different company, so a different look. Do not use glass.css there.

White page, system font stack, dark grey text `#1F2328`, one blue `#0B5FFF` for links and buttons, 6px radius, thin grey borders `#D0D7DE`. Header: "Offcut Supply" in bold text, a search box, Sign in, Cart (n). A footer on every page: "Offcut Supply is a demo store built for Hack Western 13. Nothing here is for sale." It should look like a small trade supplier's site: dense, useful, a little dated. It has a cookie notice on first visit, because real stores do and the agent should handle one.
