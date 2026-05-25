/* Reads a Minecraft .jar (vanilla or, in the future, modded) via JSZip and
 * produces a "pack" object grouped by namespace. Everything downstream
 * (registry, recipes, builder) is namespace-agnostic so adding mod jars
 * later requires no schema change &mdash; just call load() on each jar and
 * merge the namespaces. */
(function (global) {

  // Path patterns we care about. Recipes path varies across versions:
  // pre-1.21 -> data/<ns>/recipes/<name>.json
  // 1.21+    -> data/<ns>/recipe/<name>.json
  const RE = {
    texture:    /^assets\/([^/]+)\/textures\/(block|item)\/(.+)\.png$/,
    model:      /^assets\/([^/]+)\/models\/(block|item)\/(.+)\.json$/,
    blockstate: /^assets\/([^/]+)\/blockstates\/(.+)\.json$/,
    lang:       /^assets\/([^/]+)\/lang\/en_us\.json$/,
    recipe:     /^data\/([^/]+)\/recipes?\/(.+)\.json$/,
    tag:        /^data\/([^/]+)\/tags\/(?:item|items|block|blocks)\/(.+)\.json$/,
  };

  async function loadJar(file, onProgress) {
    if (!global.JSZip) throw new Error('JSZip not loaded');
    const zip = await JSZip.loadAsync(file);

    const pack = {
      sourceName: file.name,
      sourceSize: file.size,
      mcVersion: null,
      packFormat: null,
      namespaces: {}, // ns -> { blocks, items, recipes, models, textures, tags, lang, blockstates }
    };

    // Try to determine MC version
    const versionEntry = zip.file('version.json');
    if (versionEntry) {
      try {
        const v = JSON.parse(await versionEntry.async('string'));
        pack.mcVersion = v.name || v.id || null;
        if (v.pack_version) {
          pack.packFormat = typeof v.pack_version === 'object'
            ? (v.pack_version.resource ?? v.pack_version.data ?? null)
            : v.pack_version;
        }
      } catch (e) { /* ignore */ }
    }

    // Collect entries first so we can report progress
    const entries = [];
    zip.forEach((path, entry) => {
      if (entry.dir) return;
      for (const re of Object.values(RE)) {
        if (re.test(path)) { entries.push({ path, entry }); return; }
      }
    });

    let done = 0;
    const step = Math.max(1, Math.floor(entries.length / 50));

    // Process in chunks to keep UI responsive
    const CHUNK = 200;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      await Promise.all(chunk.map(({ path, entry }) => processEntry(path, entry, pack)));
      done += chunk.length;
      if (onProgress && (done % step === 0 || done === entries.length)) {
        onProgress(done, entries.length);
      }
      await new Promise(r => setTimeout(r, 0));
    }

    return pack;
  }

  function ensureNs(pack, ns) {
    let n = pack.namespaces[ns];
    if (!n) {
      n = pack.namespaces[ns] = {
        blocks: new Map(),       // name -> { id }
        items: new Map(),        // name -> { id }
        recipes: new Map(),      // name -> raw recipe json (+ ns prepended)
        models: new Map(),       // "block/x" | "item/x" -> json
        textures: new Map(),     // "block/x" | "item/x" -> blob URL
        blockstates: new Map(),  // name -> json
        tags: new Map(),         // "item/x" | "block/x" -> json
        lang: {},
      };
    }
    return n;
  }

  async function processEntry(path, entry, pack) {
    let m;
    try {
      if ((m = path.match(RE.texture))) {
        const [, ns, kind, name] = m;
        const blob = await entry.async('blob');
        ensureNs(pack, ns).textures.set(`${kind}/${name}`, URL.createObjectURL(blob));
      } else if ((m = path.match(RE.model))) {
        const [, ns, kind, name] = m;
        const json = JSON.parse(await entry.async('string'));
        ensureNs(pack, ns).models.set(`${kind}/${name}`, json);
        // item model implies an item exists
        if (kind === 'item') ensureNs(pack, ns).items.set(name, { id: `${ns}:${name}` });
      } else if ((m = path.match(RE.blockstate))) {
        const [, ns, name] = m;
        const json = JSON.parse(await entry.async('string'));
        const n = ensureNs(pack, ns);
        n.blockstates.set(name, json);
        n.blocks.set(name, { id: `${ns}:${name}` });
        // Most blocks are also items
        if (!n.items.has(name)) n.items.set(name, { id: `${ns}:${name}` });
      } else if ((m = path.match(RE.recipe))) {
        const [, ns, name] = m;
        const json = JSON.parse(await entry.async('string'));
        ensureNs(pack, ns).recipes.set(name, json);
      } else if ((m = path.match(RE.tag))) {
        const [, ns, name] = m;
        // Determine kind from the path piece between "tags/" and "/"
        const kind = path.includes('/tags/item') ? 'item' : 'block';
        const json = JSON.parse(await entry.async('string'));
        ensureNs(pack, ns).tags.set(`${kind}/${name}`, json);
      } else if ((m = path.match(RE.lang))) {
        const [, ns] = m;
        const json = JSON.parse(await entry.async('string'));
        Object.assign(ensureNs(pack, ns).lang, json);
      }
    } catch (e) {
      // Single corrupt file shouldn't abort the load
      console.warn('[jar-loader] failed on', path, e);
    }
  }

  global.MCJarLoader = { loadJar };
})(window);
