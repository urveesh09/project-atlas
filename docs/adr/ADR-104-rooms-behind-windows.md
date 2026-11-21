# ADR-104: Rooms behind the windows

Date: 2026-11-21. Status: accepted for the viewer.

## Evidence and cause

With real wall materials in place (ADR-103), the strongest remaining tell in close views of
the bundled Vue city (GT 730) was the glass: every rectangular window was one flat tinted
pane, so a tower read as a painted box. At the owner's request the author surveyed free
assets and code on 2026-11-21. Two MIT-licensed three.js interior-mapping shaders
(`mohsenheydari/three-interior-mapping`, `three-fenestra`) confirmed the technique games use
for this: trace the view ray into an imaginary room box behind the glass and colour the
pixel by what it meets. Neither fits as a dependency (one replaces the material, the other
is a demonstration), and the technique is about ten lines, so the facade shader implements
it directly. No free, clearly licensed room atlas turned up, so the rooms are rendered here.

## Decision

- **Rooms are rendered in Blender, once.** `scripts/facade-textures/rooms.py` builds 16
  furnished rooms (four living rooms, four offices, three bedrooms, two kitchens, two
  studies, a store room) from boxes and CC0 Poly Haven materials, lit by a sun through the
  window, the sky and the room's own lamps. Each is rendered as a pre-projected interior:
  the camera stands on the room's axis two half-depths in front of the window with a field
  of view that frames the opening exactly, so any point on the room box maps straight to
  the image. Furniture stays against the back and side walls and low on the floor, where a
  painted-on interior holds up from other angles. `pack.py --rooms` writes
  `apps/web/src/assets/facade-rooms.jpg`: a 1024 × 1024 4 × 4 atlas, 89 KiB.
- **The facade shader traces each window.** For rectangular windows (patterns 0–3, 7 and 9)
  the cell opens on a box one cell wide, one storey tall and 1.5 cells deep. The view ray
  is expressed in the wall's frame (its normal, world up, and the direction its across
  coordinate runs on screen, so parallax is true on every face), the nearest wall, floor
  or ceiling is found, and that point is projected into the room's render. The mip level
  follows the window's size on screen. Curtain walls and ribbon windows open on offices;
  other buildings on homes. By day a room is darker than the street; a lit window's room
  glows warm. Blinds, reveals, mullions, frames, balconies and the sky reflection are drawn
  over it as before.
- **Fallbacks.** Until the atlas loads, or if it never does, windows are the previous glass
  (`atlasRoomsReady` 0). Rooms fade to that glass where a window is under about five
  pixels, inside the existing distance fade. The lite renderer compiles all of it out.
- Rooms add hue inside windows, as glass and lit windows already did. Wall and lens colour
  are untouched, and far views keep the lens colour exactly.

## Verification

- `pnpm verify` with required browser tests on Windows, 2026-11-21: 99 test files passed,
  6 skipped; 1128 tests passed, 95 skipped.
- The browser-only privacy journey allow-lists the room atlas by name, as ADR-103 does the
  wall texture: a full-detail city (CI's WebKit) fetches both after an artifact opens.
- `apps/web/test/city-walls.test.ts` (now 6 tests): the room atlas is square, divides into
  the 4 × 4 grid at 128 px or more per room and stays under 200 KiB; the shader's office
  rooms are the atlas column `rooms.py` renders them in; rooms swap in without touching the
  walls, and a facade compiled without rooms ignores them.
- GT 730 captures of the Vue city at 1192 × 648, with the atlas and with its request blocked:
  Modern and Western compile under ANGLE (Direct3D 11) with no page errors; draw calls are
  unchanged (36, 44); frame time is the 16.7 ms median vsync cap either way. A camera
  walked up to a Modern tower shows a different room in each window, with floor, walls and
  furniture in perspective. Western's arched windows are unchanged, as designed.
- GPU time per megapixel was not measured (held until the owner asks, as in ADR-103).
- CI's software renderer runs the lite scene, so CI never compiles this path; the GT 730
  captures are its only compile evidence.
