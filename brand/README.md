# Brand

Six logo candidates, drawn Sat Nov 21. Miller picks one; until then the app uses `reup-up.svg` and `reup-wordmark.svg`.

| File | Mark |
| --- | --- |
| reup-up.svg | 1. The u and the p share one stem |
| reup-up-lean.svg | 1b. The same, leaning 8 degrees |
| reup-block-r.svg | 2. An r built from two blocks |
| reup-slots.svg | 3. The parts board, full pockets spelling r |
| reup-piece.svg | 4. A ring with the missing piece arriving |
| reup-hooks.svg | 5. Two r shapes chasing each other |
| reup-tally.svg | 6. A tally whose crossing stroke goes up |
| reup-wordmark.svg | The name, ending in mark 1 |

Each mark comes in three files: plain (uses `currentColor`, for inline SVG), `-ink` (`#16331C`) and `-light` (`#F4FAEE`) for `<img>`.

Rules: one colour, always the colour of the text around it. Never outlined, never on a gradient of its own. Keep clear space of a quarter of the mark's width around it.

`make_marks.py` redraws every file: `python brand/make_marks.py brand`
