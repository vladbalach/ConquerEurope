# Icon style: classic heraldic

How the tradition icons are drawn, so that new icons of the same family (traditions, honor, future
abilities) match them. The reference implementation is [public/js/tradition-icons.js](public/js/tradition-icons.js);
read it before drawing anything new, and reuse its helpers rather than writing new ones.

## The look in one paragraph

Classic and restrained, like a coat of arms or a struck medal. No cartoon shapes, no flat emoji-like
fills, no neon, no text. Metal is drawn as metal: gradients with a bright top-left and a dark lower
edge, a thin bevel, a thin dark ink outline and a soft cast shadow. The player's colour is a material
(an enamel field or one enamelled part), never the only thing that tells two icons apart. Something
special is set apart by quiet means (a second border line, a faint halo), never by crowns, sunbursts,
rays or gems; those were tried and rejected as "too much".

## Two sizes, two drawings

Do not shrink the big icon for small places. Small places get their own, simpler drawing.

| | Big | Small |
|---|---|---|
| Used in | Honor window (48 px) | Players list (22 px), results table (24 px), milestones (22 px) |
| Function | `drawTradition(ctx, key, color, ultimate)` | `drawTraditionSmall(ctx, key, color, ultimate)` |
| Data URL | `traditionIconURL` in sprites.js (64 x 64 logical px at 2x = 128 px) | `traditionSmallIconURL` (48 px canvas, close to display size) |
| Frame | Heraldic shield, field in the player's colour, gold border | None: the subject alone, filling ~60 of 64 px |
| Subject | Silver and gold, bevel, shadow, fine details | Bold silver glyph, one part in the player's colour, no bevel or shadow |
| Outline | 1 px ink | 2.6 px ink (in the 64 px box) |

## Palette (constants in tradition-icons.js)

| Name | Value | Use |
|---|---|---|
| `INK` | `#1a120a` | Every outline, openings (eye slits), detail lines (at 55% alpha) |
| `GOLD` | `#fff4c8 → #f2cf6e → #c9952f → #87601c → #b8903e` | Shield border, accents (crest, sword guards, cross boss) |
| `SILVER` | `#ffffff → #e4e8ee → #a9b1bc → #646c77 → #98a0aa` | The main subject on big icons |
| `LEAF_GOLD` | `#fff0b0 → #e2b54e → #a5761f` | Laurel, and gold on small icons (brighter than `GOLD`, reads at small size) |
| `STEEL` | `#ffffff → #cfd5dc → #7f8792` | The main subject on small icons |
| `FLAME` | `#fff3a0 → #f6a23a → #c3302a` | Fire, in natural colours |
| `RED` | `#ff7a6c → #c8262c → #6e0f12` | Ribbons |
| crimson line | `#7a1016` | The tier II tradition's double border |
| field | `lighten(color, 0.22) → color → darken(color, 0.45)`, top-left to bottom-right | The player's colour on the shield |
| tint (small) | `lighten(color, 0.38) → color → darken(color, 0.45)` | The one coloured part of a small icon |

Gradients run across the subject's bounding box from top-left toward bottom-right, so light always
comes from the top left.

## Big icon recipe

1. **Shield**: `shieldPath(inset)`, a heater shield 48 px wide (x 8 to 56, y 4 to 61). Fill `shieldPath(0)`
   with `GOLD` under a soft drop shadow (blur 3, offset 0/1.5, 60% black), then `bevel()` it.
2. **Field**: `shieldPath(3.4)` filled with the field gradient, a faint diagonal lattice (diaper, 0.5 px
   lines at 13% black, 6 px apart), a white radial glow at the top left (28% → 0), and a sunk bevel (dark at
   the top left, light at the bottom right). Ink outline 1 px on the field, 1.3 px on the shield.
3. **Subject**: a function returning `{ box, layers }` in a -50..50 box, drawn by `drawSubject` centred
   on the field (about x 32, y 30 to 31) at 34 to 39 px across. Every filled layer gets its gradient, a
   bevel (white 55% / black 35%) and a 1 px ink outline; the whole subject casts a small shadow on the field.
4. **Tier II** (Eternal Glory, Last Stand: `ultimate: true` in config): the same shield with a double border: `GOLD`, then `shieldPath(2.2)` in
   crimson `#7a1016`, `shieldPath(3.1)` in `GOLD`, the field at `shieldPath(4.8)`, plus a faint red radial
   halo behind the shield (`rgba(190,24,30,0.55)` → 0). Nothing more around it. The subject itself should look
   strong: mostly gold, richer in parts (a red sash, leather strips), up to 40 px across.

## Small icon recipe

1. No frame and no background (the page gives a dark tile). The subject fills about 60 of the 64 px.
2. Redraw the subject for the size: thicker parts, bigger openings, at most three fingers, fewer leaves
   (4 pairs instead of 7), a bigger star. Any detail should be at least ~4 px wide in the 64 px box.
   Compose for a square: the level handshake of the big icon became forearms rising from the bottom
   corners to a big clasp.
3. Fill with `STEEL`; gold (`LEAF_GOLD`) for accents; exactly one part, the layer marked `tint: true`,
   in the player's colour (helmet crest, the cross, the sleeves, the brazier, the star, the pteruges). Ink outline
   2.6 px on every filled shape; openings stay plain ink.
4. Tier II: a soft red glow behind (`rgba(200,40,40,0.5)` → 0). The Players list adds its red frame in CSS.

## Subjects

Pick an emblem from heraldry or antiquity that reads as a silhouette: front or side view, symmetric
where possible. Current ones:

| Tradition | Subject |
|---|---|
| Cult of Heroes | Greek helmet, front view, crest on top |
| Order of Mercy | Eight-pointed Hospitaller cross with a gold boss. Never a red cross on white: that is a protected emblem |
| Brotherhood of Arms | Two gauntlets clasped over two crossed swords, points up |
| Honored Dead | A flame burning in a brazier on a stepped foot |
| Eternal Glory | The silver honor star in a gold laurel wreath tied with a red ribbon |
| Last Stand | A gold muscled cuirass with leather pteruges and a red sash, over two crossed swords, points up |

## Layers and roles

A subject is a list of layers drawn back to front, each `{ role, path }`:

- `main` silver; `accent` gold; `blade` silver; `grip` leather; `flame`, `inner` (the flame's heart),
  `ribbon`, `star`: their own materials.
- `hole`: an opening, filled flat with ink (or the field's darkest shade), no bevel.
- `line`: a detail stroke (`w` px), clipped to `clip`; `shine`: a white highlight.
- `leaf`: drawn as one group: all leaves are stroked first (2x the outline width), then filled, so the
  wreath has one outline around it rather than one per leaf. Use this for any cluster of small shapes.
- `tint: true`: the part painted in the player's colour on small icons.

Build paths with `Path2D`; place copies with `xf(path, new DOMMatrix().translate(x, y).rotate(deg))`.
Canvas shadows ignore the transform, so `shadow()` scales them by `R` (device px per logical px).

## Adding an icon

1. Write the subject function (big) and, if it will show at 22 to 24 px, a small one; register them in
   `SUBJECTS` / `SMALL_SUBJECTS`, and set its place and size in the `at` map of `drawTradition`.
2. Look at it before committing. Headless Edge can render the module straight from disk:
   a scratch HTML page with `<script type="module">` that imports
   `file:///…/public/js/tradition-icons.js` and draws onto canvases, then
   `msedge --headless=new --allow-file-access-from-files --screenshot=out.png --window-size=900,300 file:///…/page.html`.
   Read the PNG.
3. Check it at 128 px (shape), 48 px (Honor window) and 22 px (Players list), in several player
   colours, including the hard ones: Navy `#000075`, Black `#2b2b2b`, Maroon `#800000`, Yellow
   `#ffe119` and White `#ffffff`.

## Avoid

- Cartoon shapes and flat fills (the old cone units and timber hall were replaced for this reason).
- Shrinking a big icon to 22 px instead of drawing a small one.
- Crowns, sunbursts, rays, gems and strong glows as decoration.
- Identifying an icon by the player's colour alone; dark colours vanish on dark panels.
- Thick outlines on big icons, thin outlines on small ones.
- Text or numbers inside an icon.
- A bare round shield with spears: it reads as tribal, not heraldic (tried and rejected for Last Stand).
