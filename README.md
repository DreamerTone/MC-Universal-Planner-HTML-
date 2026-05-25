# MC Universal Planner (HTML)

A browser-based Minecraft idea builder. Drop in a vanilla Minecraft
**client `.jar`** and the app extracts blocks, items, textures, and recipes
straight from your game files &mdash; no servers, no uploads, nothing baked in.

## Features

- **Jar gate**: nothing in the app is reachable until you load a `.jar`. The
  detected Minecraft version is shown in the header so any future mods can be
  matched to the correct game version.
- **Builder**: 2D top-down grid with a Y-layer slider. Place / erase / pick /
  fill, save & load builds, export to JSON.
- **Blocks browser**: searchable list of every block and item in the loaded
  pack, with textures resolved from each block's model chain.
- **Recipe view**: pick any item and see all its crafting / smelting /
  stonecutting / smithing recipes, plus the total materials needed for any
  count.
- **Build materials**: aggregate all blocks placed in the current build and
  optionally break them down to raw materials using the in-game recipe graph.
- **Local-only**: the jar is parsed in your browser using JSZip and cached in
  IndexedDB. The file never leaves your machine.

## Built for future mod support

The jar loader and registry are namespace-agnostic. Vanilla data lives under
the `minecraft` namespace; mod jars use their own namespaces. Loading
additional jars in the future will be a matter of calling
`registry.addPack(pack)` &mdash; texture resolution, recipes, and tags already
walk all loaded namespaces.

## Getting a vanilla client jar

- **Windows**: `%appdata%\.minecraft\versions\<version>\<version>.jar`
- **macOS**: `~/Library/Application Support/minecraft/versions/<version>/<version>.jar`
- **Linux**: `~/.minecraft/versions/<version>/<version>.jar`

Use the **client** jar &mdash; the server jar does not contain textures.

## Running

It's a static site. Open `index.html` directly in a modern browser, or serve
the folder with any static server:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000/`.
