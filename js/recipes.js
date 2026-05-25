/* Recipe calculator. Given a target item + count, returns the total
 * materials needed by recursively expanding recipes until either:
 *   - an item has no recipe (a raw material), or
 *   - the user opts not to break down a node, or
 *   - max depth is reached / cycle detected. */
(function (global) {

  // Heuristic recipe priority: prefer crafting over stonecutting / smelting
  // so a "stone -> stone_bricks" calculation doesn't accidentally back into
  // smelting cobblestone forever.
  const TYPE_PRIORITY = {
    crafting_shaped: 0,
    crafting_shapeless: 1,
    smithing_transform: 5,
    smithing_trim: 6,
    smelting: 8,
    blasting: 9,
    smoking: 10,
    campfire_cooking: 11,
    stonecutting: 12,
  };

  // Items we never break down further even if a recipe exists.
  // These are visually-raw / circular-looking enough that breaking them down
  // confuses users more than it helps. Conservative default list.
  const ALWAYS_RAW = new Set([
    'minecraft:cobblestone',
    'minecraft:stone',
    'minecraft:dirt',
    'minecraft:sand',
    'minecraft:gravel',
    'minecraft:netherrack',
    'minecraft:end_stone',
    'minecraft:oak_log', 'minecraft:spruce_log', 'minecraft:birch_log',
    'minecraft:jungle_log', 'minecraft:acacia_log', 'minecraft:dark_oak_log',
    'minecraft:mangrove_log', 'minecraft:cherry_log', 'minecraft:pale_oak_log',
    'minecraft:crimson_stem', 'minecraft:warped_stem',
    'minecraft:bamboo',
  ]);

  class RecipeCalculator {
    constructor(registry) {
      this.registry = registry;
    }

    bestRecipe(itemId) {
      const list = this.registry.recipes.get(itemId);
      if (!list || !list.length) return null;
      const sorted = list.slice().sort((a, b) => {
        const pa = TYPE_PRIORITY[a.type] ?? 99;
        const pb = TYPE_PRIORITY[b.type] ?? 99;
        return pa - pb;
      });
      return sorted[0];
    }

    allRecipes(itemId) {
      return this.registry.recipes.get(itemId) || [];
    }

    /* Returns { totals: Map<id, count>, tree: node }
     * options: { breakRaw: bool, maxDepth: int, extraRaw: Set } */
    materialsFor(itemId, count, opts = {}) {
      const breakRaw = opts.breakRaw !== false;
      const maxDepth = opts.maxDepth ?? 16;
      const extraRaw = opts.extraRaw || new Set();
      const totals = new Map();
      const visiting = new Set();

      const recurse = (id, qty, depth) => {
        const isStop = !breakRaw
          || depth >= maxDepth
          || visiting.has(id)
          || ALWAYS_RAW.has(id)
          || extraRaw.has(id);

        if (isStop) {
          totals.set(id, (totals.get(id) || 0) + qty);
          return { id, qty, leaf: true };
        }

        const rec = this.bestRecipe(id);
        if (!rec || !rec.inputs.length) {
          totals.set(id, (totals.get(id) || 0) + qty);
          return { id, qty, leaf: true };
        }

        visiting.add(id);
        const outCount = rec.result.count || 1;
        const batches = Math.ceil(qty / outCount);
        const node = { id, qty, leaf: false, type: rec.type, batches, outCount, children: [] };

        for (const inp of rec.inputs) {
          let resolvedId = inp.id;
          if (inp.isTag) {
            const sub = this.registry.firstItemInTag(inp.id);
            if (sub) resolvedId = sub;
            else {
              totals.set(`#${inp.id}`, (totals.get(`#${inp.id}`) || 0) + inp.count * batches);
              node.children.push({ id: `#${inp.id}`, qty: inp.count * batches, leaf: true, isTag: true });
              continue;
            }
          }
          const child = recurse(resolvedId, inp.count * batches, depth + 1);
          node.children.push(child);
        }
        visiting.delete(id);
        return node;
      };

      const tree = recurse(itemId, count, 0);
      return { totals, tree };
    }

    /* Aggregate materials for a whole build (map of blockId -> count). */
    materialsForBuild(blockCounts, opts = {}) {
      const grand = new Map();
      for (const [id, count] of blockCounts) {
        const { totals } = this.materialsFor(id, count, opts);
        for (const [k, v] of totals) grand.set(k, (grand.get(k) || 0) + v);
      }
      return grand;
    }
  }

  global.MCRecipes = RecipeCalculator;
})(window);
