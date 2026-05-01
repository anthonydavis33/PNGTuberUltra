# Sample art assets

Each built-in sample rig (the entries in the toolbar's **Sample**
dropdown) loads its art from a folder here. When the user picks a
sample, the app fetches each PNG it expects from `/samples/<sample-id>/`;
if a PNG isn't there, the sample falls back to a canvas-drawn
placeholder shape so it still works during development.

## Workflow for adding real art

1. Decide which sample you're producing art for. Check that sample's
   folder for a `README.md` that lists the expected filenames and
   approximate sizes.
2. Save your PNGs (with transparent backgrounds) into
   `public/samples/<sample-id>/` using the documented filenames.
3. Reload the app — the sample now uses your art instead of placeholder
   shapes. No code changes required.

## Why placeholder fallbacks exist

Two reasons:
- The samples need to work before art arrives so the rigging stack stays
  testable / demoable from day one.
- The placeholder shapes also document what each sprite is roughly
  meant to look like (positioning, proportions), so the artist has a
  visual reference for the rig's expectations.

If the artist's final sizes are significantly different from the
placeholders, you may need to adjust per-sprite transform values and
pose ranges in the corresponding builder under
`src/io/samples/{sample-id}/`. Search for the asset's id in that file
to find the relevant transforms.

## Adding a new sample

1. Add a builder function under `src/io/samples/` or extend the
   existing `src/io/sampleRig.ts`.
2. Add an entry to the `SAMPLES` registry there — `{ id, name,
   description, build }`.
3. Create `public/samples/<id>/` and a per-sample README listing
   expected files.
4. The toolbar dropdown picks up the new sample automatically.
