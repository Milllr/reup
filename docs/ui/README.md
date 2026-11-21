# Mockups

Static HTML, one file per screen, all styled by `specimen.css` (the source for the app's CSS). Open them in a browser: the TV screens scale to the window, `phone.html` is 390 wide.

| File | Screen |
| --- | --- |
| specimen.css | Tokens and components. Copy it and `fonts/` to apps/web/src/styles/ unchanged |
| specimen.js | Mockup helper: scales the stage and sizes each word to span the plate. The app does both in its Stage and Word components |
| fonts/ | Inter Tight and Geist Mono, variable, latin, with their OFL licences |
| shelf.html | Shelf, on the TV. Press any key, or add `?low`, for the wine state |
| shop.html | Shop: one frame per live browser |
| order.html | Order: waiting for a yes. The other states are described at the bottom of the file |
| why.html | Why: the chart, the reorder sentence, the season control |
| phone.html | Phone: approve, name a new part, counts, as stacked bands |

Teach and Ops are described in docs/UI.md and built from the same parts.

The dark board in shelf.html is a drawing that stands in for the camera feed. The pale pages in shop.html stand in for the live browser.

To check a screen from a terminal: `google-chrome --headless=new --hide-scrollbars --allow-file-access-from-files --virtual-time-budget=4000 --screenshot=shelf.png --window-size=1920,1080 docs/ui/shelf.html`
