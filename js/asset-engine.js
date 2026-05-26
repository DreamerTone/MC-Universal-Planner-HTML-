(function (global) {
  const FACES = ['north', 'east', 'south', 'west', 'up', 'down'];
  const FACE_SET = new Set(FACES);

  class MCAssetEngine {
    constructor() {
      this.reset();
    }

    reset() {
      this.packs = [];
      this.namespaces = new Set();
      this.blocks = new Map();
      this.items = new Map();
      this.lang = new Map();
      this.models = new Map();
      this.textures = new Map();
      this.textureMeta = new Map();
      this.textureMetaByUrl = new Map();
      this.blockstates = new Map();
    }

    addPack(pack) {
      this.packs.push(pack);
      for (const [ns, data] of Object.entries(pack.namespaces || {})) {
        this.namespaces.add(ns);
        for (const [key, value] of Object.entries(data.lang || {})) {
          this.lang.set(`${ns}:${key}`, value);
        }
        this._mergeMap(data.textures, (path, url) => this.textures.set(`${ns}:${path}`, url));
        this._mergeMap(data.textureMeta, (path, meta) => {
          const key = `${ns}:${path}`;
          this.textureMeta.set(key, meta);
          const url = this.textures.get(key);
          if (url) this.textureMetaByUrl.set(url, meta);
        });
        this._mergeMap(data.models, (path, model) => this.models.set(`${ns}:${path}`, model));
        this._mergeMap(data.blockstates, (name, blockstate) => {
          const id = `${ns}:${name}`;
          this.blockstates.set(id, blockstate);
          this.blocks.set(id, this._entry(ns, name, blockstate));
        });
        this._mergeMap(data.items, (name) => {
          const id = `${ns}:${name}`;
          if (!this.items.has(id)) this.items.set(id, this._entry(ns, name, null, 'item'));
        });
      }
      for (const id of this.blocks.keys()) {
        this.blocks.set(id, this._entryFromExisting(this.blocks.get(id)));
      }
    }

    _mergeMap(input, cb) {
      if (!input) return;
      if (input instanceof Map) {
        for (const [key, value] of input) cb(key, value);
      } else {
        for (const [key, value] of Object.entries(input)) cb(key, value);
      }
    }

    _entry(ns, name, blockstate, kind = 'block') {
      const id = `${ns}:${name}`;
      const displayName = this.lang.get(`${ns}:${kind}.${ns}.${name}`)
        || this.lang.get(`${ns}:block.${ns}.${name}`)
        || this.lang.get(`${ns}:item.${ns}.${name}`)
        || humanName(name);
      return {
        id,
        ns,
        name,
        kind,
        displayName,
        blockstate,
        stateSchema: stateSchemaFromBlockstate(blockstate),
        category: classifyCategory(name),
        defaultState: defaultStateFromBlockstate(blockstate, name),
      };
    }

    _entryFromExisting(entry) {
      const parts = this.partsForBlock(entry.id, entry.defaultState);
      const shape = classifyShape(entry.name, parts);
      return Object.assign({}, entry, {
        shape,
        behavior: inferBehavior(entry.name, entry.stateSchema, shape),
        icon: this.iconFor(entry.id, parts),
        fullCube: shape === 'full cube',
      });
    }

    allBlocks({ query = '', category = 'all', ns = '' } = {}) {
      const q = query.trim().toLowerCase();
      return Array.from(this.blocks.values())
        .filter(entry => !ns || entry.ns === ns)
        .filter(entry => category === 'all' || entry.category === category)
        .filter(entry => !q || `${entry.id} ${entry.displayName} ${entry.shape}`.toLowerCase().includes(q))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    categories() {
      const out = new Map([['all', 0]]);
      for (const entry of this.blocks.values()) {
        out.set('all', out.get('all') + 1);
        out.set(entry.category, (out.get(entry.category) || 0) + 1);
      }
      return Array.from(out.entries()).map(([id, count]) => ({ id, label: humanName(id), count }));
    }

    partsForBlock(id, state = {}) {
      const entry = this.blocks.get(id);
      if (!entry) return [];
      const blockstate = this.blockstates.get(id);
      const refs = [];

      if (blockstate?.variants) {
        const variant = bestVariant(blockstate.variants, state);
        for (const item of asArray(variant)) refs.push(item);
      }

      if (blockstate?.multipart) {
        for (const part of blockstate.multipart) {
          if (matchesWhen(part.when, state)) {
            for (const item of asArray(part.apply)) refs.push(item);
          }
        }
      }

      if (!refs.length) refs.push({ model: `${entry.ns}:block/${entry.name}` });

      return refs.flatMap(ref => {
        const model = this.resolveModel(ref.model, entry.ns);
        if (!model || !model.elements.length) return [];
        return [{
          source: ref.model,
          x: Number(ref.x || 0),
          y: Number(ref.y || 0),
          uvlock: !!ref.uvlock,
          elements: model.elements,
          textures: model.textures,
          ambientocclusion: model.ambientocclusion !== false,
        }];
      });
    }

    resolveModel(ref, defaultNs = 'minecraft', stack = []) {
      const key = this.modelKey(ref, defaultNs);
      if (!key || stack.includes(key)) return null;
      const raw = this.models.get(key) || this.models.get(key.replace(/^([^:]+):/, 'minecraft:'));
      if (!raw) return null;

      let base = {
        id: key,
        parent: null,
        ambientocclusion: true,
        display: {},
        textures: {},
        elements: [],
      };
      const ns = key.split(':')[0];
      if (raw.parent) {
        base = this.resolveModel(raw.parent, ns, stack.concat(key)) || base;
      }
      return {
        id: key,
        parent: raw.parent || base.parent || null,
        ambientocclusion: raw.ambientocclusion ?? base.ambientocclusion,
        display: Object.assign({}, base.display, raw.display || {}),
        textures: Object.assign({}, base.textures, raw.textures || {}),
        elements: raw.elements ? clone(raw.elements) : clone(base.elements || []),
      };
    }

    modelKey(ref, defaultNs = 'minecraft') {
      const loc = splitResource(ref, defaultNs);
      if (!loc) return null;
      return `${loc.ns}:${loc.path}`;
    }

    textureUrlForFace(face, textures, defaultNs) {
      if (!face?.texture) return null;
      let ref = face.texture;
      let safety = 16;
      while (typeof ref === 'string' && ref.startsWith('#') && safety-- > 0) {
        ref = textures[ref.slice(1)];
      }
      return this.textureUrl(ref, defaultNs);
    }

    textureUrl(ref, defaultNs = 'minecraft') {
      const loc = splitResource(ref, defaultNs);
      if (!loc) return null;
      const key = `${loc.ns}:${loc.path}`;
      return this.textures.get(key)
        || this.textures.get(key.replace(/^([^:]+):/, 'minecraft:'))
        || null;
    }

    textureMetaForUrl(url) {
      return this.textureMetaByUrl.get(url) || null;
    }

    itemLayer0(id) {
      const entry = this.blocks.get(id) || this.items.get(id);
      if (!entry) return null;
      const itemModel = this.resolveModel(`${entry.ns}:item/${entry.name}`, entry.ns);
      if (!itemModel) return null;
      const ref = resolveTextureVariable('layer0', itemModel.textures);
      if (!ref) return null;
      return this.textureUrl(ref, entry.ns);
    }

    iconFor(id, parts = null) {
      const entry = this.blocks.get(id) || this.items.get(id);
      if (!entry) return null;
      const layer0 = this.itemLayer0(id);
      if (layer0) return layer0;

      const modelParts = parts || this.partsForBlock(id, entry.defaultState || {});
      for (const part of modelParts) {
        const keys = ['particle', 'all', 'side', 'top', 'texture', 'end'];
        for (const key of keys) {
          const ref = resolveTextureVariable(key, part.textures);
          const url = this.textureUrl(ref, entry.ns);
          if (url) return url;
        }
        for (const element of part.elements) {
          for (const faceName of FACES) {
            const url = this.textureUrlForFace(element.faces?.[faceName], part.textures, entry.ns);
            if (url) return url;
          }
        }
      }
      return this.textureUrl(`${entry.ns}:block/${entry.name}`, entry.ns)
        || this.textureUrl(`${entry.ns}:item/${entry.name}`, entry.ns);
    }

    debugBlock(id, state = {}) {
      const entry = this.blocks.get(id);
      const parts = this.partsForBlock(id, state);
      return {
        entry,
        state,
        blockstate: this.blockstates.get(id) || null,
        shape: classifyShape(entry?.name || '', parts),
        parts: parts.map(part => ({
          source: part.source,
          rotation: { x: part.x, y: part.y, uvlock: part.uvlock },
          textureKeys: Object.keys(part.textures || {}),
          elementCount: part.elements.length,
          elements: part.elements.map(element => ({
            from: element.from,
            to: element.to,
            rotation: element.rotation || null,
            faces: Object.fromEntries(Object.entries(element.faces || {}).map(([face, def]) => [
              face,
              { texture: def.texture, uv: def.uv || null, rotation: def.rotation || 0, cullface: def.cullface || null },
            ])),
          })),
        })),
      };
    }
  }

  function bestVariant(variants, state) {
    let best = null;
    let score = -1;
    for (const [key, value] of Object.entries(variants)) {
      const nextScore = variantScore(key, state);
      if (nextScore >= 0 && nextScore >= score) {
        best = value;
        score = nextScore;
      }
    }
    return best;
  }

  function variantScore(key, state) {
    if (key === '' || key === 'normal') return 0;
    let score = 0;
    for (const piece of key.split(',')) {
      const [k, v] = piece.split('=');
      if (!k) continue;
      if (String(state[k]) !== v) return -1;
      score++;
    }
    return score;
  }

  function matchesWhen(when, state) {
    if (!when) return true;
    if (Array.isArray(when.OR)) return when.OR.some(item => matchesWhen(item, state));
    if (Array.isArray(when.AND)) return when.AND.every(item => matchesWhen(item, state));
    return Object.entries(when).every(([key, value]) => {
      if (key === 'OR' || key === 'AND') return true;
      const allowed = String(value).split('|');
      return allowed.includes(String(state[key]));
    });
  }

  function stateSchemaFromBlockstate(blockstate) {
    const schema = {};
    const add = (key, value) => {
      if (!key || key === 'OR' || key === 'AND') return;
      if (!schema[key]) schema[key] = new Set();
      String(value).split('|').forEach(v => schema[key].add(v));
    };
    const harvestVariantKey = (key) => {
      if (!key || key === 'normal') return;
      for (const piece of key.split(',')) {
        const [k, v] = piece.split('=');
        if (k && v !== undefined) add(k, v);
      }
    };
    const harvestWhen = (when) => {
      if (!when) return;
      if (Array.isArray(when.OR)) when.OR.forEach(harvestWhen);
      if (Array.isArray(when.AND)) when.AND.forEach(harvestWhen);
      for (const [key, value] of Object.entries(when)) {
        if (key !== 'OR' && key !== 'AND') add(key, value);
      }
    };
    Object.keys(blockstate?.variants || {}).forEach(harvestVariantKey);
    for (const part of blockstate?.multipart || []) harvestWhen(part.when);
    // Multipart `when` clauses typically only mention the truthy side
    // (`{ north: "true" }`), leaving the schema missing `false`. Pad it
    // so debug dropdowns and inference don't have to special-case.
    for (const [key, values] of Object.entries(schema)) {
      const list = Array.from(values);
      if (list.length === 1) {
        if (list[0] === 'true') values.add('false');
        else if (list[0] === 'false') values.add('true');
      }
    }
    return Object.fromEntries(Object.entries(schema).map(([key, values]) => [key, Array.from(values).sort()]));
  }

  function defaultStateFromBlockstate(blockstate, name) {
    const schema = stateSchemaFromBlockstate(blockstate);
    const keys = new Set(Object.keys(schema));
    const out = {};
    if (keys.has('axis')) out.axis = 'y';
    if (keys.has('facing')) out.facing = 'north';
    if (keys.has('rotation')) out.rotation = '0';
    if (keys.has('half')) {
      const values = schema.half || [];
      if (values.includes('lower')) out.half = 'lower';
      else if (values.includes('bottom')) out.half = 'bottom';
      else out.half = values[0] || 'bottom';
    }
    if (keys.has('shape')) out.shape = 'straight';
    if (keys.has('hanging')) out.hanging = 'false';
    if (keys.has('type')) out.type = /slab/.test(name) ? 'bottom' : (schema.type?.[0] || 'bottom');
    if (keys.has('part')) out.part = 'foot';
    if (keys.has('hinge')) out.hinge = 'left';
    if (keys.has('open')) out.open = 'false';
    if (keys.has('powered')) out.powered = 'false';
    if (keys.has('power')) out.power = '0';
    if (keys.has('delay')) out.delay = '1';
    if (keys.has('mode')) out.mode = schema.mode?.includes('compare') ? 'compare' : (schema.mode?.[0] || 'compare');
    if (keys.has('locked')) out.locked = 'false';
    if (keys.has('enabled')) out.enabled = 'true';
    if (keys.has('layers')) out.layers = '1';
    if (keys.has('level')) out.level = schema.level?.includes('0') ? '0' : (schema.level?.[0] || '0');
    if (keys.has('age')) out.age = '0';
    if (keys.has('stage')) out.stage = '0';
    if (keys.has('moisture')) out.moisture = '0';
    if (keys.has('bites')) out.bites = '0';
    if (keys.has('candles')) out.candles = '1';
    if (keys.has('pickles')) out.pickles = '1';
    if (keys.has('charges')) out.charges = '0';
    if (keys.has('eggs')) out.eggs = '1';
    if (keys.has('hatch')) out.hatch = '0';
    if (keys.has('distance')) out.distance = schema.distance?.includes('7') ? '7' : (schema.distance?.[0] || '1');
    if (keys.has('persistent')) out.persistent = 'false';
    if (keys.has('face')) out.face = 'wall';
    if (keys.has('waterlogged')) out.waterlogged = 'false';
    if (keys.has('lit')) out.lit = 'true';
    if (keys.has('occupied')) out.occupied = 'false';
    if (keys.has('in_wall')) out.in_wall = 'false';
    if (keys.has('short')) out.short = 'false';
    if (keys.has('eye')) out.eye = 'false';
    if (keys.has('disarmed')) out.disarmed = 'false';
    if (keys.has('unstable')) out.unstable = 'false';
    if (keys.has('vertical_direction')) out.vertical_direction = schema.vertical_direction?.includes('up') ? 'up' : (schema.vertical_direction?.[0] || 'up');
    if (keys.has('attach')) out.attach = 'false';
    if (keys.has('attached')) out.attached = 'false';
    if (keys.has('tilt')) out.tilt = schema.tilt?.includes('none') ? 'none' : (schema.tilt?.[0] || 'none');
    if (keys.has('sculk_sensor_phase')) out.sculk_sensor_phase = schema.sculk_sensor_phase?.includes('inactive') ? 'inactive' : (schema.sculk_sensor_phase?.[0] || 'inactive');
    for (const side of ['north', 'east', 'south', 'west', 'up', 'down']) {
      if (keys.has(side)) {
        const values = schema[side] || [];
        out[side] = values.includes('none') ? 'none' : 'false';
      }
    }
    if (/fence|pane|wall|bars/.test(name)) {
      for (const side of ['north', 'east', 'south', 'west']) {
        if (keys.has(side)) {
          const values = schema[side] || [];
          out[side] = values.includes('none') ? 'none' : 'false';
        }
      }
    }
    return out;
  }

  function classifyShape(name, parts) {
    const elements = parts.flatMap(part => part.elements || []);
    if (isFullCube(elements)) return 'full cube';
    if (/stairs/.test(name)) return 'stairs';
    if (/slab/.test(name)) return 'slab';
    if (/trapdoor/.test(name)) return 'trapdoor';
    if (/fence_gate/.test(name)) return 'fence gate';
    if (/fence/.test(name)) return 'fence';
    if (/_wall$|^wall$/.test(name)) return 'wall';
    if (/pane|bars/.test(name)) return 'pane';
    if (/_door$/.test(name)) return 'door';
    if (/_bed$|^bed$/.test(name)) return 'bed';
    if (/rail/.test(name)) return 'rail';
    if (/redstone_wire/.test(name)) return 'redstone_wire';
    if (/_chest$|^chest$|trapped_chest/.test(name)) return 'chest';
    if (/^(vine|glow_lichen|sculk_vein|resin_clump)$/.test(name)) return 'multi_face';
    if (/^carpet$|_carpet$|moss_carpet/.test(name)) return 'carpet';
    if (/_button$/.test(name)) return 'button';
    if (/lever/.test(name)) return 'lever';
    if (/pressure_plate/.test(name)) return 'pressure_plate';
    if (/wall_torch|soul_wall_torch|redstone_wall_torch/.test(name)) return 'wall_torch';
    if (/torch/.test(name)) return 'torch';
    if (/wall_sign|wall_hanging_sign/.test(name)) return 'wall_sign';
    if (/sign/.test(name)) return 'sign';
    if (/wall_banner/.test(name)) return 'wall_banner';
    if (/banner/.test(name)) return 'banner';
    if (/wall_(skull|head)/.test(name)) return 'wall_head';
    if (/(skull|head)$/.test(name)) return 'head';
    if (/lantern/.test(name)) return 'lantern';
    if (/end_rod|lightning_rod/.test(name)) return 'rod';
    if (/repeater|comparator/.test(name)) return 'redstone_component';
    if (/observer|dispenser|dropper|piston|furnace|smoker|blast_furnace|barrel|hopper|loom|lectern|stonecutter|crafter/.test(name)) return 'machine';
    if (/^snow$|snow_layer/.test(name)) return 'snow_layer';
    if (/ladder/.test(name)) return 'ladder';
    if (/sapling|flower|mushroom|roots|grass|fern|crop/.test(name)) return 'plant';
    return elements.length ? 'custom' : 'unknown';
  }

  function inferBehavior(name, schema, shape) {
    const has = (k) => k in schema;
    const hasCardinals = ['north', 'east', 'south', 'west'].every(has);
    let connector = null;
    if (shape === 'wall') connector = 'wall';
    else if (shape === 'pane') connector = 'pane';
    else if (shape === 'fence') connector = 'fence';
    return {
      axisOnPlace: has('axis'),
      horizontalFacingOnPlace: has('facing'),
      halfOnPlace: has('half'),
      hasCardinals,
      connector,
      fenceGate: shape === 'fence gate',
      solidConnectorTarget: shape === 'full cube',
      stairShape: shape === 'stairs' && has('shape'),
      slabMergeable: shape === 'slab' && has('type'),
      wallConnector: shape === 'wall',
      paneConnector: shape === 'pane',
      lanternHangable: shape === 'lantern' && has('hanging'),
      trapdoorPlacement: shape === 'trapdoor' && has('half') && has('facing'),
      doorTwoBlock: shape === 'door' && has('half') && has('hinge'),
      bedTwoBlock: shape === 'bed' && has('part'),
      doublePlant: shape === 'plant' && (schema.half || []).includes('lower') && (schema.half || []).includes('upper'),
      fenceGateInWall: shape === 'fence gate' && has('in_wall'),
      railShape: shape === 'rail' && has('shape'),
      redstoneWire: shape === 'redstone_wire' && hasCardinals,
      multiFace: shape === 'multi_face',
      redstoneTarget: shape === 'redstone_component'
        || /redstone|target|tripwire|daylight_detector|note_block/.test(name)
        || shape === 'button'
        || shape === 'lever'
        || shape === 'pressure_plate'
        || has('powered'),
      chestConnect: shape === 'chest' && has('type') && has('facing'),
      openable: has('open'),
      poweredState: has('powered'),
      sixWayFacing: has('facing') && (schema.facing || []).includes('up') && (schema.facing || []).includes('down'),
      rotationOnPlace: has('rotation'),
      floorOnly: ['rail', 'redstone_wire', 'pressure_plate', 'carpet', 'snow_layer', 'plant', 'redstone_component'].includes(shape)
        || /candle|cake|composter|daylight_detector|tripwire|repeater|comparator/.test(name),
      snowStackable: shape === 'snow_layer' && has('layers'),
      faceAttachment: has('face'),
      ladder: shape === 'ladder',
      wallTorch: shape === 'wall_torch',
      wallSign: shape === 'wall_sign',
      wallBanner: shape === 'wall_banner',
      wallHead: shape === 'wall_head',
      torch: shape === 'torch',
      sign: shape === 'sign',
      ceilingSign: shape === 'sign' && /hanging_sign/.test(name),
      banner: shape === 'banner',
      head: shape === 'head',
      shape,
    };
  }

  function isFullCube(elements) {
    if (elements.length !== 1) return false;
    const el = elements[0];
    const from = el.from || [];
    const to = el.to || [];
    const faces = el.faces || {};
    return !el.rotation
      && from[0] === 0 && from[1] === 0 && from[2] === 0
      && to[0] === 16 && to[1] === 16 && to[2] === 16
      && FACES.every(face => FACE_SET.has(face) && faces[face]);
  }

  function classifyCategory(name) {
    if (/log|wood|stem|hyphae|planks|leaves|sapling/.test(name)) return 'wood';
    if (/ore|raw_|deepslate|stone|granite|diorite|andesite|tuff|basalt|blackstone|calcite/.test(name)) return 'stone';
    if (/glass|pane|bars|fence|wall|stairs|slab|door|trapdoor|sign|ladder/.test(name)) return 'building';
    if (/lantern|torch|lamp|light|candle/.test(name)) return 'lighting';
    if (/rail|chest|barrel|crafting|furnace|anvil|table|bed|bell|cauldron/.test(name)) return 'utility';
    if (/flower|mushroom|plant|grass|fern|crop|vine|lichen|sculk_vein|resin_clump|roots/.test(name)) return 'nature';
    return 'blocks';
  }

  function splitResource(ref, defaultNs = 'minecraft') {
    if (!ref || typeof ref !== 'string') return null;
    const clean = ref.replace(/^#/, '').replace(/^textures\//, '').replace(/\.png$/, '').replace(/\.json$/, '');
    const i = clean.indexOf(':');
    if (i >= 0) return { ns: clean.slice(0, i), path: clean.slice(i + 1) };
    return { ns: defaultNs || 'minecraft', path: clean };
  }

  function resolveTextureVariable(key, textures) {
    let ref = textures && textures[key];
    let safety = 16;
    while (typeof ref === 'string' && ref.startsWith('#') && safety-- > 0) {
      ref = textures[ref.slice(1)];
    }
    return ref || null;
  }

  function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value || []));
  }

  function humanName(name) {
    return String(name || '')
      .replace(/^minecraft:/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  global.MCAssetEngine = MCAssetEngine;
  global.MCModelTools = { FACES, humanName };
})(window);
