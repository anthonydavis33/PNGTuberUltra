# Head Pose — art assets

Drop these PNG files into this folder to replace the placeholder
shapes. Until they're present, the sample falls back to canvas-drawn
circles + ellipses.

## Required files

| Filename | Recommended size | Purpose |
|----------|------------------|---------|
| `body.png` | 140 × 200 | A neck + shoulders / upper torso shape. Anchored at center; the rig places it below the head with no bindings (pure visual anchor). |
| `head.png` | 200 × 200 | Face shape with **eye whites visible but NO pupils** + an optional mouth. Pupils are drawn as separate sprites in this rig so they can move with mouse position and clip to the head outline. The rig also doubles `head.png` as a CLIPPING MASK for the pupils — anywhere `head.png` has alpha > 0, pupils can render; everywhere else they're cut. So design the head outline thoughtfully: a clean hard edge, full-alpha inside, transparent outside. |
| `pupil.png` | 30 × 30 | A single pupil shape (used for both left and right eyes). Place visible content roughly centered in the canvas. The rig has small pose bindings (~6-8 px range) on each pupil so they track the cursor inside the eye-white area; clipping against `head.png` keeps them from escaping the face. |

## Critical design notes for the head

The head sprite serves three purposes simultaneously:

1. **Visible art** — what the user sees when looking at the avatar.
2. **Pupil clip mask** — alpha shape that bounds where pupils can render.
3. **Bound geometry** — the rig uses `scaleX` / `scaleY` / `rotation`
   pose bindings on this sprite, so the whole face transforms as a unit.

This means the head's eye-white regions need to be drawn ON the head
sprite (so the pupil can sit on top of them and look correct). The
pupil sprite is a tiny dot that moves around — the eye sockets are
baked into the head art.

## Limitation worth knowing about

The Head Pose rig deliberately includes a `scaleX: -0.12` in its
MouseX pose binding to fake a "head turning" perspective shift. This
will visibly squish the entire head art uniformly — including the
eye-white shapes — when the user moves their mouse far left or right.
That's the affine transform ceiling of pose bindings; a real 3D-style
head turn would need 4-corner mesh deformation that we haven't built
yet. The sample is intentionally exposing this limitation, so don't
treat the squishing as a bug in the art.

If you'd prefer the sample DOESN'T have that effect (because the
squish looks worse with detailed art than with the placeholder
ellipses), you can edit the binding in the editor after loading the
sample — open the Head sprite's Bindings list and remove the `scaleX`
target from the MouseX pose binding.
