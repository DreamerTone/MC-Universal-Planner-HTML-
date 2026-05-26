# MC Universal Planner

A static Minecraft idea planner that reads the same asset files Minecraft uses:
blockstates, models, texture references, language files, and PNG textures from a
client jar or resource pack.

## Why this rebuild exists

The first version guessed too much. Fences, lanterns, signs, plants, and stairs
all expose the same basic "cuboid element" model format, so names like
`cube_all` are not enough to know how a block should render.

This version starts with a small asset engine:

- Resolve resource locations by namespace, so vanilla and modpack assets can
  live side by side.
- Resolve model parent chains before rendering.
- Resolve texture variables like `#all`, `#side`, `#texture`, and `#layer0`.
- Resolve blockstate `variants` and `multipart` rules before creating meshes.
- Render from model `elements`, `faces`, rotations, UVs, and blockstate model
  rotations instead of hand-built block guesses.
- Classify a true full cube only when the resolved geometry is exactly one
  unrotated 0-16 element with all six faces.
- Infer behavior descriptors from blockstate properties, so connection and
  placement rules are driven by states such as `north`, `east`, `facing`,
  `axis`, `half`, and wall-specific `low` / `none` connectors.

## Sources I Used

- Blockbench Java Block/Item format source:
  https://github.com/JannisX11/blockbench/blob/8fe8d9d9568de8233d77cd592744acad495d46b0/js/formats/java/java_block.js
- Blockbench Java format/texture docs:
  https://www.blockbench.net/wiki/blockbench/formats/
  https://www.blockbench.net/wiki/api/textures/
- Minecraft blockstate format:
  https://minecraft.wiki/w/Blockstates_definition/format
- Prismarine Viewer model preparation:
  https://github.com/PrismarineJS/prismarine-viewer/blob/bead85c57a2365e7c88bfe36ee1944da51f8449f/viewer/lib/modelsBuilder.js
- Prismarine minecraft-assets project:
  https://github.com/PrismarineJS/minecraft-assets

## Using It

Open `index.html` in a browser, or serve the folder:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000/`.

Load a vanilla client jar from:

- Windows: `%appdata%\.minecraft\versions\<version>\<version>.jar`
- macOS: `~/Library/Application Support/minecraft/versions/<version>/<version>.jar`
- Linux: `~/.minecraft/versions/<version>/<version>.jar`

Press `E` to open the creative inventory. Use the Debug panel to inspect the
resolved blockstate, model parts, texture keys, element bounds, face UVs, and
shape classification for the selected block.

## Behavior Research

The block behavior plan is tracked in `docs/behavior-research.md`. The short
version: render from jar assets, infer common behavior from blockstate schemas
and tags, and implement vanilla behavior families instead of hardcoding every
block id one by one. Connector blocks are solved after placement from the final
neighbor graph, then rebuilt with the state values their blockstate schema
expects.
