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

Each mark comes in three files: plain (uses `currentColor`, for inline SVG), `-ink` (`#1E1A19`, for the paper plate) and `-light` (`#F7FBE2`, cream, for the olive and wine plates) for `<img>`.

Rules: one colour, always the colour of the text around it (docs/UI.md). Never outlined, never on a gradient. Keep clear space of a quarter of the mark's width around it.

`make_marks.py` redraws every file: `python brand/make_marks.py brand`
