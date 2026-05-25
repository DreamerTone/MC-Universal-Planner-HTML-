/* Registry: builds searchable lists of blocks/items from one or more packs
 * and provides texture/display-name resolution. Designed to merge multiple
 * packs (future: vanilla base + mod jars) by walking namespaces. */
(function (global) {

  // Texture-key preference for picking a single icon out of a model that
  // may declare many faces.
  const TEXTURE_KEY_PREF = [
    'all', 'side', 'front', 'cross', 'plant', 'crop', 'fan', 'rail',
    'up', 'top', 'end', 'layer0', 'texture', 'particle', 'down', 'bottom', 'back',
  ];

  class Registry {
    constructor() {
      this.packs = [];                 // ordered list of loaded packs
      this.blocks = new Map();         // "ns:name" -> { id, ns, name, kind:'block', texture, displayName }
      this.items = new Map();          // "ns:name" -> { id, ns, name, kind:'item', texture, displayName }
      this.namespaces = new Set();
      this.recipes = new Map();        // "ns:name" -> normalized recipe
    }

    addPack(pack) {
      this.packs.push(pack);
      this._index();
    }

    reset() {
      this.packs = [];
      this.blocks.clear();
      this.items.clear();
      this.namespaces.clear();
      this.recipes.clear();
    }

    _index() {
      this.blocks.clear();
      this.items.clear();
      this.namespaces.clear();
      this.recipes.clear();

      for (const pack of this.packs) {
        for (const [ns, data] of Object.entries(pack.namespaces)) {
          this.namespaces.add(ns);

          for (const [name, _b] of data.blocks) {
            const id = `${ns}:${name}`;
            const tex = this._resolveTexture(ns, name, 'block');
            this.blocks.set(id, {
              id, ns, name, kind: 'block',
              texture: tex,
              displayName: this._displayName(ns, name, 'block'),
            });
          }
          for (const [name, _i] of data.items) {
            const id = `${ns}:${name}`;
            if (this.blocks.has(id)) continue;
            const tex = this._resolveTexture(ns, name, 'item');
            this.items.set(id, {
              id, ns, name, kind: 'item',
              texture: tex,
              displayName: this._displayName(ns, name, 'item'),
            });
          }
          for (const [name, rec] of data.recipes) {
            // Normalize and key by the recipe's *output*. We may have many
            // recipes per output (e.g. stonecutting + crafting); we keep
            // them all in a list.
            const norm = this._normalizeRecipe(rec, ns);
            if (!norm) continue;
            const list = this.recipes.get(norm.result.id) || [];
            list.push(norm);
            this.recipes.set(norm.result.id, list);
          }
        }
      }
    }

    /* ---------- texture resolution ---------- */

    _resolveTexture(ns, name, kind) {
      const pack = this._packFor(ns);
      if (!pack) return null;
      const nsData = pack.namespaces[ns];

      // Strategy 1: explicit model lookups, in preferred order
      const tryModels = kind === 'block'
        ? [`block/${name}`, `item/${name}`]
        : [`item/${name}`, `block/${name}`];

      for (const key of tryModels) {
        const model = nsData.models.get(key);
        if (model) {
          const tex = this._pickTextureFromModel(model);
          if (tex) return tex;
        }
      }

      // Strategy 2: blockstate's first variant model
      if (kind === 'block') {
        const bs = nsData.blockstates.get(name);
        if (bs) {
          const modelRef = this._firstModelInBlockstate(bs);
          if (modelRef) {
            const [mns, mpath] = this._splitRef(modelRef, ns);
            const modelKey = mpath.replace(/^block\//, 'block/'); // assume "block/..."
            const model = this._modelsFor(mns)?.get(modelKey)
                       || this._modelsFor(mns)?.get(mpath);
            if (model) {
              const tex = this._pickTextureFromModel(model);
              if (tex) return tex;
            }
          }
        }
      }

      // Strategy 3: direct texture file lookup
      return nsData.textures.get(`block/${name}`)
          || nsData.textures.get(`item/${name}`)
          || null;
    }

    _firstModelInBlockstate(bs) {
      if (bs.variants) {
        for (const v of Object.values(bs.variants)) {
          const variant = Array.isArray(v) ? v[0] : v;
          if (variant && variant.model) return variant.model;
        }
      }
      if (bs.multipart) {
        for (const part of bs.multipart) {
          const apply = Array.isArray(part.apply) ? part.apply[0] : part.apply;
          if (apply && apply.model) return apply.model;
        }
      }
      return null;
    }

    _pickTextureFromModel(model, visited = new Set()) {
      const merged = this._collectTextures(model, visited);
      // Resolve any "#var" references in merged map first
      const resolveVar = (val) => {
        let safety = 8;
        while (typeof val === 'string' && val.startsWith('#') && safety-- > 0) {
          val = merged[val.slice(1)];
        }
        return val;
      };
      for (const k of TEXTURE_KEY_PREF) {
        if (k in merged) {
          const ref = resolveVar(merged[k]);
          const tex = this._lookupTextureRef(ref);
          if (tex) return tex;
        }
      }
      for (const v of Object.values(merged)) {
        const ref = resolveVar(v);
        const tex = this._lookupTextureRef(ref);
        if (tex) return tex;
      }
      return null;
    }

    _collectTextures(model, visited, depth = 0) {
      if (!model || depth > 10) return {};
      const out = {};
      let cur = model;
      while (cur && depth < 10) {
        if (cur.textures) {
          for (const [k, v] of Object.entries(cur.textures)) {
            if (!(k in out)) out[k] = v;
          }
        }
        if (!cur.parent) break;
        const [pns, ppath] = this._splitRef(cur.parent, 'minecraft');
        const key = `${pns}:${ppath}`;
        if (visited.has(key)) break;
        visited.add(key);
        cur = this._modelsFor(pns)?.get(ppath);
        depth++;
      }
      return out;
    }

    _lookupTextureRef(ref) {
      if (!ref || typeof ref !== 'string' || ref.startsWith('#')) return null;
      const [ns, path] = this._splitRef(ref, 'minecraft');
      return this._packFor(ns)?.namespaces[ns]?.textures.get(path) || null;
    }

    _splitRef(ref, defaultNs) {
      if (ref.includes(':')) {
        const [ns, ...rest] = ref.split(':');
        return [ns, rest.join(':')];
      }
      return [defaultNs, ref];
    }

    _packFor(ns) {
      for (const p of this.packs) if (p.namespaces[ns]) return p;
      return null;
    }
    _modelsFor(ns) {
      return this._packFor(ns)?.namespaces[ns]?.models;
    }

    /* ---------- display name ---------- */

    _displayName(ns, name, kind) {
      const pack = this._packFor(ns);
      if (pack) {
        const lang = pack.namespaces[ns]?.lang;
        if (lang) {
          const k1 = `${kind}.${ns}.${name}`;
          if (lang[k1]) return lang[k1];
          const other = kind === 'block' ? 'item' : 'block';
          const k2 = `${other}.${ns}.${name}`;
          if (lang[k2]) return lang[k2];
        }
      }
      return MCUI.humanName(`${ns}:${name}`);
    }

    /* ---------- recipe normalization ----------
     * Accepts both pre-1.20.5 ("item", "tag") and 1.20.5+ ("id", string ingredients)
     * formats. Output is a uniform shape:
     *   { id, type, ns, name, inputs: [{ id, isTag, count }], result: { id, count } }
     */
    _normalizeRecipe(rec, ns) {
      if (!rec || !rec.type) return null;
      const type = rec.type.replace(/^minecraft:/, '');
      const baseResult = this._normalizeResult(rec.result);
      if (!baseResult) return null;

      const norm = {
        id: baseResult.id,
        type,
        ns,
        inputs: [],
        result: baseResult,
      };

      switch (type) {
        case 'crafting_shaped': {
          // pattern + key
          const counts = new Map();
          const isTag = new Map();
          const pattern = (rec.pattern || []).join('');
          const key = rec.key || {};
          for (const ch of pattern) {
            if (ch === ' ' || ch === '.') continue;
            const k = key[ch];
            const ing = this._normalizeIngredient(k);
            if (!ing) continue;
            counts.set(ing.id, (counts.get(ing.id) || 0) + 1);
            isTag.set(ing.id, ing.isTag);
          }
          for (const [id, count] of counts) {
            norm.inputs.push({ id, count, isTag: isTag.get(id) });
          }
          norm.pattern = rec.pattern;
          norm.key = this._normalizeKey(rec.key);
          break;
        }
        case 'crafting_shapeless': {
          const counts = new Map();
          const isTag = new Map();
          for (const item of (rec.ingredients || [])) {
            const ing = this._normalizeIngredient(item);
            if (!ing) continue;
            counts.set(ing.id, (counts.get(ing.id) || 0) + 1);
            isTag.set(ing.id, ing.isTag);
          }
          for (const [id, count] of counts) {
            norm.inputs.push({ id, count, isTag: isTag.get(id) });
          }
          break;
        }
        case 'smelting':
        case 'blasting':
        case 'smoking':
        case 'campfire_cooking': {
          const ing = this._normalizeIngredient(rec.ingredient);
          if (ing) norm.inputs.push({ id: ing.id, count: 1, isTag: ing.isTag });
          break;
        }
        case 'stonecutting': {
          const ing = this._normalizeIngredient(rec.ingredient);
          if (ing) norm.inputs.push({ id: ing.id, count: 1, isTag: ing.isTag });
          break;
        }
        case 'smithing_transform':
        case 'smithing_trim': {
          for (const k of ['template', 'base', 'addition']) {
            if (rec[k]) {
              const ing = this._normalizeIngredient(rec[k]);
              if (ing) norm.inputs.push({ id: ing.id, count: 1, isTag: ing.isTag });
            }
          }
          break;
        }
        default:
          // Unknown / custom type. Try generic ingredient/ingredients.
          if (rec.ingredient) {
            const ing = this._normalizeIngredient(rec.ingredient);
            if (ing) norm.inputs.push({ id: ing.id, count: 1, isTag: ing.isTag });
          }
          if (Array.isArray(rec.ingredients)) {
            for (const x of rec.ingredients) {
              const ing = this._normalizeIngredient(x);
              if (ing) norm.inputs.push({ id: ing.id, count: 1, isTag: ing.isTag });
            }
          }
      }

      return norm;
    }

    _normalizeResult(result) {
      if (!result) return null;
      if (typeof result === 'string') {
        return { id: this._fullId(result), count: 1 };
      }
      // 1.20.5+ uses "id"; older uses "item".
      const id = result.id || result.item;
      if (!id) return null;
      return { id: this._fullId(id), count: result.count || 1 };
    }

    _normalizeIngredient(ing) {
      if (ing == null) return null;
      if (typeof ing === 'string') {
        if (ing.startsWith('#')) return { id: this._fullId(ing.slice(1)), isTag: true };
        return { id: this._fullId(ing), isTag: false };
      }
      if (Array.isArray(ing)) {
        // Choice list: just use the first option for material totals.
        for (const opt of ing) {
          const r = this._normalizeIngredient(opt);
          if (r) return r;
        }
        return null;
      }
      if (typeof ing === 'object') {
        if (ing.item) return { id: this._fullId(ing.item), isTag: false };
        if (ing.id)   return { id: this._fullId(ing.id),   isTag: false };
        if (ing.tag)  return { id: this._fullId(ing.tag),  isTag: true };
      }
      return null;
    }

    _normalizeKey(key) {
      if (!key) return null;
      const out = {};
      for (const [k, v] of Object.entries(key)) {
        out[k] = this._normalizeIngredient(v);
      }
      return out;
    }

    _fullId(s) {
      return s.includes(':') ? s : `minecraft:${s}`;
    }

    /* ---------- public lookups ---------- */

    get(id) {
      return this.blocks.get(id) || this.items.get(id) || null;
    }

    allEntries({ kind = 'all', ns = null, query = '' } = {}) {
      const q = query.trim().toLowerCase();
      const out = [];
      const push = (m) => {
        if (kind !== 'all' && m.kind !== kind) return;
        if (ns && m.ns !== ns) return;
        if (q && !m.id.toLowerCase().includes(q) && !m.displayName.toLowerCase().includes(q)) return;
        out.push(m);
      };
      if (kind !== 'item') for (const v of this.blocks.values()) push(v);
      if (kind !== 'block') for (const v of this.items.values()) push(v);
      out.sort((a, b) => a.id.localeCompare(b.id));
      return out;
    }

    firstItemInTag(tagId) {
      const [ns, name] = this._splitRef(tagId, 'minecraft');
      const pack = this._packFor(ns);
      if (!pack) return null;
      const nsData = pack.namespaces[ns];
      // tag could be under item/ or block/; try item first
      const tag = nsData.tags.get(`item/${name}`) || nsData.tags.get(`block/${name}`);
      if (!tag || !Array.isArray(tag.values)) return null;
      for (const v of tag.values) {
        const val = typeof v === 'string' ? v : (v && v.id);
        if (!val) continue;
        if (val.startsWith('#')) {
          const sub = this.firstItemInTag(val.slice(1));
          if (sub) return sub;
        } else {
          const id = this._fullId(val);
          if (this.get(id)) return id;
        }
      }
      return null;
    }
  }

  global.MCRegistry = Registry;
})(window);
