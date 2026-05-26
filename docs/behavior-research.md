# Minecraft Block Behavior Research

This planner should not try to copy the Minecraft client blindly. The better
target is a creative planning simulator: accurate visual placement for building
blocks, understandable state editing, and stable fallbacks for unknown modded
content.

## What The Jar Gives Us

The vanilla client jar and resource packs are excellent for rendering:

- `assets/<namespace>/blockstates/*.json` chooses models from block state values.
- `assets/<namespace>/models/block/*.json` defines parent chains, texture keys,
  cuboid elements, rotations, face UVs, and culling hints.
- `assets/<namespace>/textures/block/*.png` and older `textures/blocks/*.png`
  provide the pixels.
- `assets/<namespace>/lang/en_us.json` provides display names.
- `data/<namespace>/tags/blocks/*.json` can group blocks such as logs, fences,
  walls, mineable blocks, and special support categories.
- Recipes and loot tables help with planner material counts, but not placement.

The jar does not directly provide every gameplay function. Placement and
neighbor-update behavior comes from Java classes such as stairs, slabs, fences,
walls, panes, doors, redstone wire, rails, beds, signs, chests, and fluids.

## Source Notes

- Minecraft Wiki blockstate format documents variants and multipart selection:
  https://minecraft.wiki/w/Blockstates_definition/format
- Minecraft Wiki block states/data values list state properties and values:
  https://minecraft.fandom.com/wiki/Block_states
  https://minecraft.fandom.com/wiki/Java_Edition_data_values
- Minecraft Wiki block entity page explains blocks with extra saved data:
  https://minecraft.fandom.com/wiki/Block_entity
- Fabric Yarn API pages expose Java block class behavior names without bundling
  Mojang code:
  https://maven.fabricmc.net/docs/yarn-23w43a%2Bbuild.1/net/minecraft/block/FenceBlock.html
  https://maven.fabricmc.net/docs/yarn-1.20.1%2Bbuild.2/net/minecraft/block/WallBlock.html
  https://maven.fabricmc.net/docs/yarn-20w51a%2Bbuild.9/net/minecraft/block/StairsBlock.html
  https://maven.fabricmc.net/docs/yarn-1.20.1-rc1%2Bbuild.1/net/minecraft/block/SlabBlock.html
- PrismarineJS `minecraft-data` is a strong optional source for generated block,
  item, collision, material, and versioned data:
  https://github.com/PrismarineJS/minecraft-data

## Recommended Approach

Use a hybrid behavior engine:

1. **Asset resolver**: Always render from resolved blockstates and model JSON.
2. **State schema inference**: Read all possible block state keys and values from
   variants and multipart `when` clauses.
3. **Tag inference**: Use block tags for broad groups like fences, walls, slabs,
   stairs, logs, mineable materials, replaceable plants, and support rules.
4. **Vanilla behavior profiles**: Add small functions for known behavior families
   instead of hardcoding every block id individually.
5. **Debug Stick mode**: Let the user click a placed block and cycle real state
   values. This covers rare cases and modded blocks even when automatic behavior
   is incomplete.
6. **Mod fallback**: If a modded block has familiar state names, apply matching
   vanilla profiles. If it has unknown state names, render it correctly and let
   Debug Stick/manual state editing handle the rest.

Mod support is not impossible. Fully automatic mod behavior is impossible from
assets alone, because mods can put arbitrary Java code behind a block. Visual
model support and common placement behavior are still realistic.

## Behavior Families To Implement

### High Priority Building Blocks

- **Full cubes**: no placement state; support connector blocks.
- **Axis blocks**: logs, pillars, stems, basalt; set `axis` from clicked face.
- **Horizontal facing blocks**: furnaces, barrels, ladders, signs, buttons,
  trapdoors, doors, fence gates; set `facing` from hit face or camera.
- **Slabs**: set `type=top/bottom`; merge same slab into `type=double`.
- **Stairs**: set `facing`, `half`, and recompute `shape` from neighboring
  stairs.
- **Fences**: boolean `north/east/south/west`; connect to solid blocks, other
  fences, and perpendicular fence gates.
- **Walls**: `north/east/south/west` values are `none`, `low`, or `tall`; set
  `up`; connect to solid blocks, walls, panes, and gates based on vanilla-like
  rules.
- **Panes/bars**: boolean cardinal connectors; connect to solid blocks and same
  connector family.
- **Doors**: two-block placement with `half=lower/upper`, `hinge`, `open`, and
  `powered`.
- **Trapdoors**: `facing`, `half`, `open`, and `powered`.
- **Signs/hanging signs**: floor/wall variants, `rotation` or `facing`, and a
  simple block-entity text placeholder.
- **Beds**: two-block placement with `part=head/foot`, `facing`, and `occupied`.

### Medium Priority Visual/Planner Blocks

- **Lanterns/chains/end rods**: face/attachment placement.
- **Torches/wall torches/coral fans**: floor vs wall block ids and facing.
- **Carpets/snow layers/candles/cakes/composters**: layer/count/level states.
- **Rails**: directional shape from neighbors; powered/detector/activator state.
- **Chests**: single/left/right type, facing, waterlogged, block entity content.
- **Plants/crops**: age, half, and attachment states; mostly visual in planner.
- **Fluids/waterlogged**: keep state value for rendering, but do not simulate
  fluid spread in the builder.

### Low Priority Simulation Blocks

- Redstone dust, repeaters, comparators, pistons, observers, sculk, note blocks,
  command blocks, hoppers, entities, ticking plants, random ticks, block drops,
  AI/pathfinding, and full fluid physics.

These can be represented visually and state-edited, but the planner should not
try to become a Minecraft server.

## Decision

Do not hardcode every vanilla block id as the main strategy. Hardcode behavior
families and let blockstate schemas/tags attach blocks to those families. This
keeps vanilla accurate where it matters and keeps modded blocks from becoming
hopeless.
