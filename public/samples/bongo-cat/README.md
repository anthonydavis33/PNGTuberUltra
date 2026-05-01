# Bongo Cat — art assets

Drop these PNG files into this folder to replace the placeholder
shapes. Until they're present, the sample falls back to canvas-drawn
rectangles + ovals so the rig still loads and the bindings work.

## Required files

| Filename | Recommended size | Purpose |
|----------|------------------|---------|
| `body.png` | 220 × 180 | The cat's torso + head silhouette. The placeholder includes simple ear triangles up top — feel free to incorporate that shape language. The rig rotates this sprite -8° at rest so it reads as facing into the screen corner. |
| `eyes.png` | 120 × 50 | Two eyes on a transparent background. The MicVolume binding squishes this sprite vertically while the user is talking, so leave a little vertical headroom for the squish. |
| `paw.png` | 70 × 50 | A single paw. Used for BOTH the left paw (slides between QWER/ASDF letter positions) and the right paw (follows the mouse). The rig flips orientation per side via the sprite's rotation, so a single asymmetric paw shape is fine. |
| `mouse.png` | 60 × 80 | A computer mouse prop. Sits under the right paw as visual context for the "right paw on a mouse" rig. |

## Anchoring + proportions notes

- All sprites use anchor (0.5, 0.5). If your art has a logical pivot
  that isn't dead center (e.g. the paw's "wrist"), you can change the
  anchor in the editor after loading the sample.
- Body's apparent center should be near the canvas (sprite-image)
  center, since the rig's transform places the body at world (0, 20).
- Paws are placed relative to the body — left paw resting at world
  (-75, 85), right paw at (90, 95). If your paw art is significantly
  larger / smaller than 70×50, the resting positions in `sampleRig.ts`
  may need adjustment to keep the paws visually on the keyboard / mouse.

## Transparent backgrounds

All four files should have transparent backgrounds (PNG alpha). The rig
relies on per-pixel alpha for hit-testing in the editor and for
clean compositing.
