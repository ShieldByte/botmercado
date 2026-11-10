// ==UserScript==
// @name         PokéBonk Trainer
// @namespace    pb-trainer
// @version      3.4
// @description  Panel sencillo para ver y cambiar vida, oro, XP y estadísticas en PokéBonk (modo práctica)
// @match        https://pokebonk.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
//
// CÓMO SE USA
//  1) Instálalo en Tampermonkey/Violentmonkey (recomendado: carga antes que el juego).
//     También puedes pegarlo en la consola (F12), pero encontrará menos cosas.
//  2) Recarga pokebonk.com. El trainer se engancha al juego mientras carga y la
//     pestaña ⚡ Rápido dice "🔗 Conectado". Al empezar una partida verás tu Vida,
//     Oro, XP, Nivel, Escudo, Revivir, Rerolls y todas las estadísticas reales.
//  3) Si el juego se actualiza y el enganche deja de funcionar, el panel lo avisa y
//     usa la búsqueda de antes (🔎 Buscar → "✔ Es este").
//
// MODO PRÁCTICA
//  Si en una partida usas cualquier truco, el trainer NO deja que esa partida se
//  envíe al servidor (checkpoints ni resultado final), para no meter marcas falsas
//  en el ranking de otros jugadores. La partida se juega normal; solo no cuenta.
//  El indicador 🟠 en la barra superior te avisa cuándo está activo.
//
// F2 muestra/oculta el panel (y suelta el mouse del juego). PB.ui() lo vuelve a abrir.

(() => {
  'use strict';
  if (window.PB && window.PB.__v >= 3) { window.PB.ui(); return; }

  // ===================== Enganche al juego (lo más importante) =====================
  // PokéBonk guarda la partida dentro de un módulo de JavaScript, invisible desde fuera.
  // Antes de que el juego cargue, descargamos su módulo principal, le añadimos UNA cosa
  // (guardar la instancia de la app en window.__pbApp) y le decimos al navegador, con un
  // "import map", que use esa copia. Así el trainer edita la partida real:
  //   __pbApp.run.gold, __pbApp.run.player.hp / maxHp / xp / level / stats…
  // Si algo falla (otra versión del juego, etc.), el juego carga normal y el trainer
  // usa la detección automática de antes.
  const HOOK = { ok: false, why: '', mode: '' };
  const BOOT_PAGE = '/version.json';   // página del mismo sitio que no carga el juego
  const BOOT_KEY = 'pb-boot';
  (function hookGame() {
    try {
      if (window.__pbApp) { HOOK.ok = true; HOOK.mode = 'ya enganchado'; return; }
      const get = u => {
        const x = new XMLHttpRequest();
        x.open('GET', u, false);   // síncrono a propósito: hay que terminar antes de que cargue el juego
        x.send();
        if (x.status !== 200) throw new Error(`${u} → ${x.status}`);
        return x.responseText;
      };
      // Descarga el módulo principal y le agrega window.__pbApp. Devuelve { html, url, map }.
      const prepare = pageURL => {
        const html = get(pageURL);
        const em = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/i);
        if (!em) throw new Error('no encontré el script del juego');
        const entryURL = new URL(em[1], pageURL).href;
        const entry = get(entryURL);
        const mains = [...new Set([...entry.matchAll(/["'](\.\/[\w-]+\.js)["']/g)].map(m => new URL(m[1], entryURL).href))]
          .filter(u => u !== entryURL && /\/main-/.test(u));
        for (const u of mains) {
          const src = get(u);
          let n = 0;
          let out = src.replace(/await new ([\w$]+)\(\)\.boot\(\)/, (m, c) => { n++; return `await (globalThis.__pbApp=new ${c}()).boot()`; });
          if (!n) continue;
          // las importaciones relativas ("./three-….js") deben ser absolutas dentro de la copia
          out = out.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\2/g, (m, pre, q, p) => pre + q + new URL(p, u).href + q);
          const blob = URL.createObjectURL(new Blob([out], { type: 'text/javascript' }));
          return { html, map: JSON.stringify({ imports: { [u]: blob } }) };
        }
        throw new Error('esta versión del juego cambió (no encontré dónde engancharme)');
      };

      const params = new URLSearchParams(location.search);

      // --- Caso 3: estamos en la página de arranque → montar el juego enganchado aquí ---
      if (location.pathname === BOOT_PAGE && params.has(BOOT_KEY)) {
        const target = params.get(BOOT_KEY) || '/';
        if (!target.startsWith('/') || target.startsWith('//')) throw new Error('destino inválido');
        try {
          history.replaceState(null, '', target);
          const { html, map } = prepare(location.href);
          window.stop();
          document.open();
          document.write(html.replace(/<head([^>]*)>/i, `<head$1><script type="importmap">${map}<\/script>`));
          document.close();
          HOOK.ok = true;
          HOOK.mode = 'arranque';
        } catch (e) {
          // si algo falla, ir al juego normal sin volver a intentarlo
          try { sessionStorage.setItem('pb:noboot', '1'); } catch {}
          location.replace(target);
          throw e;
        }
        return;
      }
      if (location.pathname === BOOT_PAGE) return;   // version.json normal: no tocar

      // --- Caso 1: llegamos antes que el script del juego → import map ---
      if (!document.querySelector('script[type="module"]')) {
        const { map } = prepare(location.href);
        const s = document.createElement('script');
        s.type = 'importmap';
        s.textContent = map;
        (document.head || document.documentElement).prepend(s);
        HOOK.ok = true;
        HOOK.mode = 'import map';
        return;
      }

      // --- Caso 2: llegamos tarde (Tampermonkey a veces se inyecta después) ---
      // Se pasa por la página de arranque, que no carga el juego, y desde ahí se monta enganchado.
      let noboot = false;
      try { noboot = sessionStorage.getItem('pb:noboot') === '1'; sessionStorage.removeItem('pb:noboot'); } catch {}
      if (noboot) { HOOK.why = 'no se pudo enganchar en el arranque'; return; }
      HOOK.mode = 'redirigiendo';
      window.stop();
      location.replace(`${BOOT_PAGE}?${BOOT_KEY}=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
    } catch (e) {
      HOOK.why = String(e && e.message || e).split('\n')[0].slice(0, 120);
    }
  })();
  if (HOOK.mode === 'redirigiendo') return;   // la página se va a recargar enganchada
  if (!HOOK.ok) console.warn('[PB] Sin enganche directo:', HOOK.why);

  // Partida actual (solo si el enganche funcionó y hay una partida en curso)
  const game = () => {
    try {
      const run = window.__pbApp && window.__pbApp.run;
      return run && run.player ? run : null;
    } catch { return null; }
  };

  // ============================ Configuración ============================
  const MAX_DEPTH = 10;
  const MAX_NODES = 800000;      // límite de la búsqueda manual
  const DETECT_NODES = 400000;   // límite de la detección automática
  const MAX_SHOWN = 60;          // a partir de cuántos candidatos se muestran en lista
  const API_HOST = 'api.pokebonk.com';
  const LS = { pins: 'pb:pins', slots: 'pb:slots', pos: 'pb:pos', hidden: 'pb:hidden', god: 'pb:god', bak: 'pb:backup:' };
  const ROOT_SKIP = new Set([
    'window', 'self', 'top', 'parent', 'frames', 'globalThis', 'document',
    'location', 'navigator', 'performance', 'localStorage', 'sessionStorage',
    'indexedDB', 'caches', 'crypto', 'chrome', 'PB', 'history', 'screen',
    'visualViewport', 'speechSynthesis', 'customElements', 'clientInformation',
    '__THREE_DEVTOOLS__'
  ]);
  const FN_SKIP = new Set(['prototype', 'caller', 'arguments', 'length', 'name']);

  // Estadísticas del jugador (nombres de build.stats del reporte)
  const STAT_GROUPS = [
    ['❤ Vida y defensa', {
      maxHp: 'Vida máxima', regen: 'Regeneración', healing: 'Curación ×', lifesteal: 'Robo de vida',
      overheal: 'Sobrecuración', shieldMax: 'Escudo máximo', armor: 'Armadura', evasion: 'Evasión', thorns: 'Espinas'
    }],
    ['💰 Oro, XP y suerte', {
      gold: 'Oro ganado ×', xpGain: 'XP ganada ×', pickupRange: 'Alcance para recoger', luck: 'Suerte'
    }],
    ['⚔ Combate', {
      damage: 'Daño ×', physical: 'Daño físico ×', special: 'Daño especial ×', attackSpeed: 'Vel. de ataque',
      critChance: 'Prob. de crítico', critDamage: 'Daño crítico', megaCrit: 'Mega críticos', area: 'Área',
      duration: 'Duración', projectiles: 'Proyectiles extra', projSpeed: 'Vel. de proyectiles',
      statusChance: 'Prob. de estado', statusDamage: 'Daño de estados', eliteDamage: 'Daño a élites',
      eliteSpawn: 'Aparición de élites', superEffective: 'Súper eficaz ×', powerup: 'Potenciadores'
    }],
    ['🏃 Movimiento', {
      moveSpeed: 'Vel. de movimiento', extraJumps: 'Saltos extra', jumpHeight: 'Altura de salto', slam: 'Golpe al caer'
    }],
  ];
  const STAT_LABEL = Object.assign({}, ...STAT_GROUPS.map(g => g[1]));
  const STAT_KEYS = Object.keys(STAT_LABEL);

  // Valores "vivos" de la partida que aparecen en ⚡ Rápido
  // direct: dónde está cada valor en la partida real (run = __pbApp.run)
  const SLOTS = [
    { id: 'hp',      icon: '❤',  name: 'Vida',      keys: ['hp', 'health', 'life', 'curHp'], preset: 'vida',   direct: r => [r.player, 'hp'] },
    { id: 'maxHp',   icon: '💗', name: 'Vida máx.', keys: ['maxHp', 'hpMax', 'maxHealth'],   preset: 'otro',   direct: r => [r.player, 'maxHp'] },
    { id: 'shield',  icon: '🔰', name: 'Escudo',    keys: ['shield'],                        preset: 'otro',   direct: r => [r.player, 'shield'] },
    { id: 'gold',    icon: '💰', name: 'Oro',       keys: ['gold', 'coins', 'money'],        preset: 'dinero', direct: r => [r, 'gold'] },
    { id: 'xp',      icon: '⭐', name: 'XP',        keys: ['xp', 'exp'],                     preset: 'xp',     direct: r => [r.player, 'xp'] },
    { id: 'level',   icon: '🎖', name: 'Nivel',     keys: ['level', 'lvl'],                  preset: 'otro',   direct: r => [r.player, 'level'] },
    { id: 'revives', icon: '💫', name: 'Revivir',   keys: ['revives'],                       preset: 'otro',   direct: r => [r.player, 'revives'] },
    { id: 'rerolls', icon: '🎲', name: 'Rerolls',   keys: ['rerolls'],                       preset: 'otro',   direct: r => [r, 'rerolls'] },
  ];
  const SLOT = Object.fromEntries(SLOTS.map(s => [s.id, s]));
  const PLAYER_KEYS = ['hp', 'maxHp', 'level', 'xp', 'exp', 'gold', 'kills', 'stage', 'shield', 'luck'];
  const RUN_KEYS = ['kills', 'stage', 'level', 'xp', 'hp', 'chests', 'berries', 'balls', 'shop', 'sold'];
  const PLAYER_HINT = ['level', 'xp', 'exp', 'gold', 'stats', 'luck', 'kills', 'items', 'moves', 'maxHp'];

  const PRESETS = {
    vida:   { icon: '❤',  name: 'Vida', slot: 'hp',   down: '💥 Recibí daño', up: '💚 Me curé', act: 'recibe un golpe o cúrate' },
    dinero: { icon: '💰', name: 'Oro',  slot: 'gold', down: '🛒 Gasté',       up: '🪙 Gané',    act: 'recoge o gasta oro' },
    xp:     { icon: '⭐', name: 'XP',   slot: 'xp',   down: '⬇ Bajó',         up: '⭐ Subió',   act: 'derrota a un enemigo' },
    otro:   { icon: '🎯', name: 'Otro', slot: null,   down: '⬇ Bajó',         up: '⬆ Subió',   act: 'haz que ese valor cambie' },
  };

  // Referencias originales (antes de instalar los ganchos)
  const J = JSON.stringify.bind(JSON);
  const _setItem = Storage.prototype.setItem;
  const _mapSet = Map.prototype.set;
  const _setAdd = Set.prototype.add;
  const lsSet = (k, v) => { try { _setItem.call(localStorage, k, v); } catch {} };
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch {} };
  const lsJSON = (k, def) => { try { return JSON.parse(lsGet(k)) ?? def; } catch { return def; } };

  const isNum = x => typeof x === 'number' && Number.isFinite(x);
  const get = (o, k) => { try { return o[k]; } catch { return undefined; } };
  const countNum = (o, keys) => { let n = 0; for (const k of keys) if (isNum(get(o, k))) n++; return n; };
  const pause = () => new Promise(r => setTimeout(r, 0));
  let ui = null;

  // ================= Captura del estado que el juego esconde =================
  // El juego guarda su estado dentro de módulos, no en window. Lo atrapamos cuando
  // lo guarda (localStorage/IndexedDB), cuando crea su escena 3D, o cuando mete un
  // objeto con pinta de "jugador" (tiene hp + level/xp/gold/stats...) en un Map o Set.
  const roots = new Map();      // save:*, idb:*, scene#*
  const capture = (name, obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (!roots.has(name) && roots.size >= 40) return;
    _mapSet.call(roots, name, obj);
  };

  const lives = [];             // { o, score, n } — los mejores candidatos a jugador
  const liveSeen = new WeakSet();
  let liveN = 0;
  function grabLive(v) {
    let score = 0;
    try {
      if (typeof v.hp !== 'number' || liveSeen.has(v)) return;
      for (const k of PLAYER_HINT) if (k in v) score++;
    } catch { return; }
    if (score < 2) return;
    liveSeen.add(v);
    const e = { o: v, score, n: ++liveN };
    if (lives.length < 15) lives.push(e);
    else {
      // reemplaza al peor (los enemigos suelen tener menos campos que el jugador)
      let w = 0;
      for (let i = 1; i < lives.length; i++) {
        if (lives[i].score < lives[w].score || (lives[i].score === lives[w].score && lives[i].n < lives[w].n)) w = i;
      }
      if (lives[w].score > score) return;
      lives[w] = e;
    }
    scheduleDetect();
  }
  const inGame = () => lives.length > 0 || [...roots.keys()].some(k => k.startsWith('scene'));

  // ======================= Modo práctica (red) =======================
  // Si se usó un truco en la partida actual, no se envían checkpoints ni el resultado.
  // El juego guarda la partida y la reenvía al recargar ("Hemos recuperado tu última
  // partida"), así que los id de partidas con trucos se recuerdan para bloquearlas también después.
  let dirty = false;
  let blockedSends = 0;
  let runId = null;
  const dirtyRuns = new Set(lsJSON('pb:dirtyRuns', []));
  const saveDirty = () => lsSet('pb:dirtyRuns', J([...dirtyRuns].slice(-50)));
  const markDirty = () => {};
  const gotRunId = id => {
    if (id == null) return;
    runId = String(id);
    if (dirty) { dirtyRuns.add(runId); saveDirty(); }
  };
  const RUN_RE = /^\/runs\/[^/]+(?:\/checkpoint)?\/?$/;
  const START_RE = /^\/runs\/?$/;
  function netCheck(u, method) {
    return 'ok';
  }

  // ============================ Referencias ============================
  const readRef = r => { try { return r.o[r.k]; } catch { return undefined; } };
  // Solo escribe números válidos sobre campos que ya son números, y anota el valor anterior
  // para poder deshacerlo si el juego empieza a fallar (ver "vigilante" más abajo).
  const recentWrites = [];   // { o, k, old, t }
  const writeRef = (r, v) => {
    try {
      const old = r.o[r.k];
      if (!isNum(v) || !isNum(old)) return false;
      if (old !== v) {
        r.o[r.k] = v;
        recentWrites.push({ o: r.o, k: r.k, old, t: Date.now() });
        if (r.k === 'luck' && isNum(r.o.luckMult)) {
          // el juego calcula luckMult = 1 + luck/100 al recalcular; si no se ajusta, cofres,
          // tragamonedas y potenciadores seguirían usando la suerte vieja
          const lm = 1 + v / 100;
          if (r.o.luckMult !== lm) { recentWrites.push({ o: r.o, k: 'luckMult', old: r.o.luckMult, t: Date.now() }); r.o.luckMult = lm; }
        }
        if (recentWrites.length > 200) recentWrites.splice(0, recentWrites.length - 200);
        markDirty();
      }
      return true;
    } catch { return false; }
  };

  // ============================ Recorrido de objetos ============================
  const ident = /^[A-Za-z_$][\w$]*$/;
  const pathKey = k => ident.test(k) ? '.' + k : `[${J(k)}]`;
  const fnToString = Function.prototype.toString;
  const isNative = f => { try { return /\{\s*\[native code\]\s*\}\s*$/.test(fnToString.call(f)); } catch { return false; } };
  const CONST_KEY = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

  const scannable = v => {
    if (!v || (typeof v !== 'object' && typeof v !== 'function')) return false;
    if (typeof v === 'function' && isNative(v)) return false;
    try {
      if (typeof Node !== 'undefined' && v instanceof Node) return false;
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
      if (v.isVector2 || v.isVector3 || v.isVector4 || v.isMatrix3 || v.isMatrix4 || v.isQuaternion ||
          v.isEuler || v.isColor || v.isBufferGeometry || v.isMaterial || v.isTexture || v.isBufferAttribute) return false;
      const cn = (v.constructor && v.constructor.name) || '';
      if (/WebGL|Audio|CSS|^Event$|Worker|Image|Canvas/.test(cn)) return false;
    } catch { return false; }
    return true;
  };

  // BFS desde lo capturado y desde window. Cede el control cada ~25 ms para no congelar el juego.
  async function walk({ onProp, onObj, onProgress, limit = MAX_NODES } = {}) {
    const seen = new WeakSet([window]);
    const q = [];
    const addRoot = (name, o) => { if (o && !seen.has(o)) { seen.add(o); q.push({ o, p: `root(${J(name)})`, d: 0 }); } };
    for (const e of lives) addRoot('live#' + e.n, e.o);
    for (const [name, o] of roots) addRoot(name, o);
    q.push({ o: window, p: 'window', d: 0 });
    let n = 0, t = performance.now();
    for (let i = 0; i < q.length && n < limit; i++) {
      if (performance.now() - t > 25) {
        if (onProgress) onProgress(n);
        await pause();
        t = performance.now();
      }
      const { o, p, d } = q[i];
      if (onObj) { try { onObj(o, p); } catch {} }
      let keys;
      try { keys = Object.getOwnPropertyNames(o); } catch { continue; }
      const isFn = typeof o === 'function';
      for (const k of keys) {
        if (o === window && ROOT_SKIP.has(k)) continue;
        if (isFn && FN_SKIP.has(k)) continue;
        let v;
        try { v = o[k]; } catch { continue; }
        if (typeof v === 'number' && CONST_KEY.test(k)) continue;
        n++;
        if (onProp) onProp(o, k, v, p);
        if (d < MAX_DEPTH && scannable(v) && !seen.has(v)) {
          seen.add(v);
          q.push({ o: v, p: p + pathKey(k), d: d + 1 });
        }
      }
      if (o instanceof Map) {
        for (const [mk, mv] of o) {
          if (scannable(mv) && !seen.has(mv)) {
            seen.add(mv);
            q.push({ o: mv, p: `${p}.get(${J(String(mk))})`, d: d + 1 });
          }
        }
      }
    }
    return n;
  }

  // Convierte una ruta de texto (window.a.b["c"] o root("live#3").hp) en { o, k }
  const STR = '"(?:[^"\\\\]|\\\\.)*"';
  const HEAD_RE = new RegExp(`^(?:window|root\\((${STR})\\))`);
  const TOK_RE = new RegExp(`\\.get\\((${STR})\\)|\\.([A-Za-z_$][\\w$]*)|\\[(${STR})\\]`, 'y');
  const rootGet = name => {
    if (roots.has(name)) return roots.get(name);
    const m = /^live#(\d+)$/.exec(name);
    if (m) { const e = lives.find(x => x.n === +m[1]); return e && e.o; }
  };
  const mapGet = (m, s) => {
    if (m.has(s)) return m.get(s);
    for (const [k, v] of m) if (String(k) === s) return v;
  };
  function resolve(path) {
    const h = HEAD_RE.exec(String(path || ''));
    if (!h) return null;
    let cur = h[1] ? rootGet(JSON.parse(h[1])) : window;
    const steps = [];
    let pos = h[0].length;
    while (pos < path.length) {
      TOK_RE.lastIndex = pos;
      const t = TOK_RE.exec(path);
      if (!t) return null;
      pos = TOK_RE.lastIndex;
      steps.push(t[1] !== undefined ? { get: JSON.parse(t[1]) } : { k: t[2] !== undefined ? t[2] : JSON.parse(t[3]) });
    }
    const last = steps.pop();
    if (!last || last.get !== undefined) return null;
    try {
      for (const s of steps) {
        if (cur == null) return null;
        cur = s.get !== undefined ? (cur instanceof Map ? mapGet(cur, s.get) : undefined) : cur[s.k];
      }
    } catch { return null; }
    return (cur && (typeof cur === 'object' || typeof cur === 'function')) ? { o: cur, k: last.k, p: path } : null;
  }

  // ============================ Valores conocidos (slots) ============================
  const slots = {};                         // id -> { o, k, p, manual }
  const savedSlots = lsJSON(LS.slots, {});  // id -> { p, manual }
  // Rutas que apuntan a la escena 3D o a partidas guardadas nunca son el valor vivo: se descartan
  for (const [id, sv] of Object.entries(savedSlots)) {
    if (!sv || !sv.p || /^root\("(?:scene|save|idb)/.test(sv.p)) delete savedSlots[id];
  }
  try { localStorage.setItem(LS.slots, JSON.stringify(savedSlots)); } catch {}
  let detectedStats = null;                 // { o, p } estadísticas encontradas por detección (modo sin enganche)

  function slotRef(id) {
    const run = game();
    if (run && SLOT[id] && SLOT[id].direct) {
      try {
        const [o, k] = SLOT[id].direct(run);
        if (o && isNum(o[k])) return { o, k, p: 'juego.' + (o === run ? '' : 'player.') + k };
      } catch {}
    }
    // Conectado al juego: solo valen los valores reales. Una ruta vieja de búsqueda manual
    // puede apuntar a cualquier cosa (p. ej. a la sombra de la escena 3D) y romper el juego.
    if (hooked()) return null;
    const s = slots[id];
    if (s && isNum(readRef(s))) return s;
    const sv = savedSlots[id];
    if (sv && sv.p) {
      const r = resolve(sv.p);
      if (r && isNum(readRef(r))) return (slots[id] = { o: r.o, k: r.k, p: sv.p, manual: !!sv.manual });
    }
    return null;
  }
  const slotVal = id => { const r = slotRef(id); return r ? readRef(r) : undefined; };
  const slotsOk = () => !!slotRef('hp');

  // Nivel: se usa la función del propio juego (sube xpNext, encola las cartas de mejora).
  // Escribir "level" a mano dejaba la barra de XP desfasada.
  // El juego ofusca algunos nombres de métodos y los cambia entre versiones
  // (gainLevel → $18xkwf0…). Se buscan por lo que hace su código, no por su nombre.
  const fnSrc = f => { try { return Function.prototype.toString.call(f); } catch { return ''; } };
  function findMethod(obj, test) {
    for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(p, k);
        if (d && typeof d.value === 'function' && test(fnSrc(d.value))) return k;
      }
    }
    return null;
  }
  const methodCache = new WeakMap();
  function gameMethods(pl) {
    const proto = Object.getPrototypeOf(pl);
    let m = methodCache.get(proto);
    if (m) return m;
    const recompute = findMethod(pl, src => /evoStage\s*\+\s*this\.growth/.test(src) && /this\.stats\s*=/.test(src));
    const gainLevel = findMethod(pl, src => /^[^(]*\(\)\s*\{\s*this\.level\+\+/.test(src));
    let xpFor = null;
    if (gainLevel) {
      const mm = /this\.xpNext\s*=\s*this\.([\w$]+)\(/.exec(fnSrc(Object.getPrototypeOf(pl)[gainLevel] || pl[gainLevel]));
      if (mm) xpFor = mm[1];
    }
    m = { recompute, gainLevel, xpFor };
    methodCache.set(proto, m);
    if (!recompute || !gainLevel) console.warn('[PB] No encontré algunos métodos del juego:', m);
    return m;
  }
  const callRecompute = pl => { const k = pl && gameMethods(pl).recompute; if (k) pl[k](); return !!k; };

  function levelUp(n) {
    const run = game();
    const pl = run && run.player;
    const k = pl && gameMethods(pl).gainLevel;
    if (!k) return false;
    for (let i = 0; i < Math.min(n, 50); i++) pl[k]();
    markDirty();
    return true;
  }
  function setLevel(v) {
    const run = game();
    const pl = run && run.player;
    if (!pl || !isNum(pl.level)) return false;
    v = Math.max(1, Math.round(v));
    if (v > pl.level) return levelUp(v - pl.level);
    if (v < pl.level) {
      writeRef({ o: pl, k: 'level' }, v);
      const xf = gameMethods(pl).xpFor;
      if (xf && typeof pl[xf] === 'function') {
        writeRef({ o: pl, k: 'xpNext' }, pl[xf](v));
        writeRef({ o: pl, k: 'xp' }, Math.min(pl.xp, pl.xpNext * 0.99));
      }
    }
    return true;
  }
  const hooked = () => HOOK.ok && !!window.__pbApp;
  // El juego crea un objeto de estadísticas nuevo cada vez que recalcula (al subir de nivel
  // o tomar un objeto), así que siempre se lee el actual.
  function curStats() {
    const run = game();
    if (run) {
      try { const so = run.player.stats; if (so && typeof so === 'object') return { o: so, p: 'juego.player.stats' }; } catch {}
    }
    return detectedStats;
  }
  function setSlot(id, ref, manual) {
    slots[id] = { o: ref.o, k: ref.k, p: ref.p, manual: !!manual };
    savedSlots[id] = { p: ref.p, manual: !!manual };
    lsSet(LS.slots, J(savedSlots));
  }

  // ============================ Detección automática ============================
  let detecting = false, lastDetect = 0, detectTimer = 0;

  async function detect(onProgress) {
    const players = [], statsC = [], runs = [];
    const keep = (arr, item) => { arr.push(item); arr.sort((a, b) => b.score - a.score); if (arr.length > 5) arr.length = 5; };
    const n = await walk({
      limit: DETECT_NODES,
      onProgress,
      onObj: (o, p) => {
        if (typeof o !== 'object' || o === window || Array.isArray(o)) return;
        const saved = /^root\("(?:save|idb):/.test(p) ? 4 : 0;   // preferir estado vivo a guardados
        const s = countNum(o, STAT_KEYS);
        if (s >= 6) { keep(statsC, { o, p, score: s - saved }); return; }
        const hasHp = isNum(get(o, 'hp')), hasGold = isNum(get(o, 'gold'));
        if (hasHp) {
          let sc = countNum(o, PLAYER_KEYS) - saved;
          const so = get(o, 'stats');
          if (so && typeof so === 'object' && countNum(so, STAT_KEYS) >= 6) sc += 4;
          if (/player|hero|trainer|jugador/i.test(p)) sc += 3;
          if (/enem|mob|foe|boss|spawn|wild/i.test(p)) sc -= 4;
          if (sc >= 3) keep(players, { o, p, score: sc });
        }
        if (hasGold) {
          const sc = countNum(o, RUN_KEYS) - saved;
          if (sc >= 1) keep(runs, { o, p, score: sc });
        }
      }
    });

    const P = players[0] || null, R = runs[0] || null;
    let St = null;
    if (P) {
      const so = get(P.o, 'stats');
      if (so && typeof so === 'object' && countNum(so, STAT_KEYS) >= 6) St = { o: so, p: P.p + '.stats' };
    }
    if (!St && statsC[0]) St = statsC[0];

    const pick = (slot, cands) => {
      for (const c of cands) {
        if (!c || !c.o) continue;
        for (const k of slot.keys) if (isNum(get(c.o, k))) return { o: c.o, k, p: c.p + pathKey(k) };
      }
      return null;
    };
    const found = {
      hp:    pick(SLOT.hp, [P]),
      maxHp: pick(SLOT.maxHp, [P, St]),
      gold:  pick(SLOT.gold, [P, R]),   // stats.gold es multiplicador, no el oro que tienes
      xp:    pick(SLOT.xp, [P, R]),
      level: pick(SLOT.level, [P, R]),
    };
    for (const [id, r] of Object.entries(found)) {
      const cur = slots[id];
      if (cur && cur.manual && isNum(readRef(cur))) continue;   // no pisar lo que elegiste a mano
      if (r) setSlot(id, r, false);
    }
    if (St) detectedStats = { o: St.o, p: St.p };
    lastDetect = Date.now();
    console.log(`[PB] Detección: ${n.toLocaleString()} propiedades · jugador ${P ? '✓ ' + P.p : '✗'} · estadísticas ${St ? '✓ ' + St.p : '✗'}`);
    return { player: !!P, stats: !!St };
  }

  async function runDetect() {
    if (hooked()) return { player: !!game(), stats: !!curStats() };   // conectado: no hace falta buscar
    if (detecting || scanning) return null;
    detecting = true;
    if (ui) { ui.progress('Buscando al jugador…'); ui.renderQuick(); }
    try {
      return await detect(n => ui && ui.progress(`Buscando al jugador… ${n.toLocaleString()}`));
    } finally {
      detecting = false;
      if (ui) { ui.progress(null); ui.renderQuick(); }
    }
  }
  function scheduleDetect(delay = 3000) {
    if (hooked() || detecting || slotsOk()) return;
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
      if (!slotsOk() && Date.now() - lastDetect > 8000) runDetect();
    }, delay);
  }
  setInterval(() => { if (inGame() && !slotsOk()) scheduleDetect(0); }, 15000);

  // ============================ Búsqueda manual ============================
  let cands = [];       // { o, k, p, last }
  let scanning = false;
  const near = (x, v) => typeof x === 'number' && Math.abs(x - v) < 1;

  async function scanValue(v, onProgress) {
    cands = [];
    await walk({ onProgress, onProp: (o, k, x, p) => { if (near(x, v)) cands.push({ o, k, p: p + pathKey(k), last: x }); } });
  }
  async function snapAll(onProgress) {
    cands = [];
    await walk({ onProgress, onProp: (o, k, x, p) => { if (isNum(x)) cands.push({ o, k, p: p + pathKey(k), last: x }); } });
  }
  function refilter(test) {
    cands = cands.filter(c => {
      const x = readRef(c);
      const ok = typeof x === 'number' && test(x, c.last);
      c.last = x;
      return ok;
    });
  }
  async function find(re, max = 200) {
    const out = [];
    await walk({ onProp: (o, k, x, p) => { if (out.length < max && re.test(k)) out.push({ o, k, p: p + pathKey(k) }); } });
    return out;
  }
  const describe = x => Array.isArray(x) ? `Array(${x.length})`
    : (x && typeof x === 'object') ? ((x.constructor && x.constructor.name) || 'Object')
    : typeof x === 'function' ? 'función'
    : x;

  // ============================ Valores fijados ============================
  // Un fijado puede apuntar a un slot (Vida, Oro…), a una estadística (luck…) o a una ruta.
  let pins = lsJSON(LS.pins, []);
  if (!Array.isArray(pins)) pins = [];
  // Un fijado guardado por ruta (de una búsqueda manual) puede apuntar a otro objeto tras recargar
  // y romper el juego al escribirle cada 50 ms: esos empiezan sin fijar en cada carga.
  for (const p of pins) if (!p.slot && !p.stat) p.fz = false;
  let god = lsJSON(LS.god, { on: false, val: 0 });

  // ===================== Multiplicadores =====================
  // El juego recalcula las estadísticas con player.recompute() (al subir de nivel, tomar un
  // objeto, etc.) y crea un objeto nuevo cada vez. Se envuelve ese método: primero calcula el
  // juego y después se multiplica el resultado. Así el multiplicador nunca se pierde.
  const MULTS = [
    ['⚔ Ataque', [['damage', 'Daño'], ['physical', 'Daño físico'], ['special', 'Daño especial'],
      ['attackSpeed', 'Vel. de ataque'], ['critDamage', 'Daño crítico'], ['critChance', 'Prob. de crítico'],
      ['area', 'Área'], ['duration', 'Duración'], ['projSpeed', 'Vel. de proyectiles']]],
    ['❤ Defensa', [['maxHp', 'Vida máx.'], ['regen', 'Regeneración'], ['armor', 'Armadura'], ['healing', 'Curación']]],
    ['🏃 Otros', [['moveSpeed', 'Vel. de movimiento'], ['pickupRange', 'Alcance para recoger'],
      ['xpGain', 'XP ganada'], ['gold', 'Oro ganado']]],
  ];
  const MULT_KEYS = MULTS.flatMap(g => g[1].map(x => x[0]));
  let mults = lsJSON('pb:mults', {});
  if (!mults || typeof mults !== 'object' || Array.isArray(mults)) mults = {};
  for (const k of Object.keys(mults)) if (!MULT_KEYS.includes(k) || !isNum(mults[k]) || mults[k] <= 0) delete mults[k];
  const multOn = () => Object.values(mults).some(m => m !== 1);
  const saveMults = () => lsSet('pb:mults', J(mults));

  function applyMults(st) {
    let changed = false;
    for (const k of MULT_KEYS) {
      const m = mults[k];
      if (!isNum(m) || m === 1 || !isNum(st[k])) continue;
      st[k] *= m;
      changed = true;
    }
    if (!changed) return false;
    // mismos topes que pone el juego: el crítico que pasa de 100% se vuelve mega crítico
    if (isNum(st.critChance) && st.critChance > 1) {
      st.megaCrit = Math.max(st.megaCrit || 0, Math.min(1, st.critChance - 1));
      st.critChance = 1;
    }
    if (isNum(st.attackSpeed)) st.attackSpeed = Math.max(0.3, st.attackSpeed);
    return true;
  }

  const wrappedPlayers = new WeakSet();
  function hookRecompute(pl) {
    if (!pl || wrappedPlayers.has(pl)) return;
    const key = gameMethods(pl).recompute;
    if (!key || typeof pl[key] !== 'function') return;
    wrappedPlayers.add(pl);
    const orig = pl[key];
    pl[key] = function () {
      const hp0 = this.hp, max0 = this.maxHp;
      const out = orig.apply(this, arguments);
      try {
        if (this.stats && applyMults(this.stats)) {
          markDirty();
          // el juego copia stats.maxHp a player.maxHp: se repite con el valor multiplicado,
          // sumando a la vida actual solo lo que creció el máximo (igual que hace el juego)
          const mx = Math.round(this.stats.maxHp);
          if (isNum(mx) && mx > 0) {
            this.maxHp = mx;
            this.hp = isNum(hp0) && isNum(max0) ? Math.min(mx, hp0 + Math.max(0, mx - max0)) : Math.min(this.hp, mx);
          }
        }
      } catch {}
      return out;
    };
    if (multOn()) { try { callRecompute(pl); } catch {} }
  }
  function refreshStats() {
    const run = game();
    if (!run || !run.player) return false;
    hookRecompute(run.player);
    try { if (!callRecompute(run.player)) return false; } catch { return false; }
    return true;
  }
  function setMult(k, m) {
    if (!MULT_KEYS.includes(k)) return false;
    if (!isNum(m) || m <= 0 || m === 1) delete mults[k];
    else mults[k] = Math.min(m, 1000);
    saveMults();
    if (multOn()) markDirty();
    return refreshStats();
  }

  const activeCheats = () => !!god.on || pins.some(p => p.fz) || multOn();

  const pinId = p => p.slot ? 'slot:' + p.slot : p.stat ? 'stat:' + p.stat : 'path:' + p.path;
  const savePins = () => lsSet(LS.pins, J(pins.map(({ label, path, slot, stat, val, fz }) => ({ label, path, slot, stat, val, fz }))));
  const pinRef = p => p.slot ? slotRef(p.slot)
    : p.stat ? (curStats() ? { o: curStats().o, k: p.stat } : null)
    : (resolve(p.path) || p._ref || null);
  const pinRead = p => { const r = pinRef(p); return r ? readRef(r) : undefined; };
  const pinWrite = (p, v) => { const r = pinRef(p); return r ? writeRef(r, v) : false; };

  function addPin(spec) {
    const id = pinId(spec);
    let p = pins.find(x => pinId(x) === id);
    if (p) Object.assign(p, { val: spec.val, fz: spec.fz ?? p.fz });
    else {
      p = { label: spec.label, path: spec.path, slot: spec.slot, stat: spec.stat, val: spec.val, fz: !!spec.fz };
      pins.push(p);
    }
    if (spec.ref) p._ref = spec.ref;
    savePins();
    return p;
  }
  function toggleFreeze(spec) {
    const p = pins.find(x => pinId(x) === pinId(spec));
    if (p && p.fz) { p.fz = false; savePins(); return false; }
    addPin({ ...spec, fz: true });
    return true;
  }
  const isFrozen = spec => !!pins.find(x => x.fz && pinId(x) === pinId(spec));

  // Vigilante: el juego termina la partida tras ~60 fotogramas seguidos con error.
  // Si empieza a fallar justo después de un cambio nuestro, se deshace y se sueltan los fijados.
  function watchdog() {
    let failing = 0;
    try { failing = (window.__pbApp && window.__pbApp.failing) || 0; } catch {}
    if (failing < 3) return;
    const since = Date.now() - 3000;
    const undo = recentWrites.filter(w => w.t >= since);
    if (!undo.length && !god.on && !pins.some(p => p.fz) && !multOn()) return;
    if (multOn()) { mults = {}; saveMults(); try { const run = game(); run && run.player && callRecompute(run.player); } catch {} }
    for (let i = undo.length - 1; i >= 0; i--) { try { undo[i].o[undo[i].k] = undo[i].old; } catch {} }
    recentWrites.length = 0;
    let freed = 0;
    for (const p of pins) if (p.fz) { p.fz = false; freed++; }
    if (freed) savePins();
    if (god.on) { god = { ...god, on: false }; lsSet(LS.god, J(god)); }
    console.warn(`[PB] El juego empezó a dar error: se deshicieron ${undo.length} cambio(s), se soltaron los fijados y se quitaron los multiplicadores.`);
    if (ui) { ui.toast('⚠ El juego dio error con un cambio: lo deshice y solté los fijados', true); ui.renderQuick(); ui.renderPins(); }
  }

  // ---------- Inmortal: la vida nunca baja de un mínimo ----------
  // Un bucle cada 50 ms no alcanza: el juego resta el golpe y revisa "vida <= 0" en la misma
  // función, así que un golpe más grande que tu vida te mataba antes de que el bucle actuara.
  // Ahora "hp" del jugador pasa por un filtro: con Inmortal activo, cualquier valor que el
  // juego intente poner por debajo del mínimo se queda en el mínimo, en el mismo instante.
  const godFloor = pl => {
    const f = isNum(god.floor) && god.floor > 0 ? god.floor : 10;
    return isNum(pl.maxHp) && pl.maxHp > 0 ? Math.min(f, pl.maxHp) : f;
  };
  const guardedPlayers = new WeakSet();
  function guardHp(pl) {
    if (!pl || guardedPlayers.has(pl)) return;
    const d = Object.getOwnPropertyDescriptor(pl, 'hp');
    if (!d || !('value' in d) || !d.configurable) return;
    guardedPlayers.add(pl);
    let hp = d.value;
    Object.defineProperty(pl, 'hp', {
      configurable: true,
      enumerable: d.enumerable,
      get() { return hp; },
      set(v) {
        if (god.on && typeof v === 'number') {
          const f = godFloor(this);
          if (!(v >= f)) { v = f; markDirty(); }   // también atrapa NaN
        }
        hp = v;
      },
    });
  }

  // Bucle que mantiene los valores fijos y el modo inmortal
  setInterval(() => {
    watchdog();
    { const run = game(); if (run && run.player) { hookRecompute(run.player); guardHp(run.player); } }
    for (const p of pins) if (p.fz) pinWrite(p, p.val);
    if (god.on && god.fill !== false) {
      const r = slotRef('hp');
      if (r) {
        const mx = slotVal('maxHp');
        const target = isNum(mx) && mx > 0 ? mx : god.val;
        const cur = readRef(r);
        if (isNum(cur) && isNum(target) && cur < target) writeRef(r, target);
      }
    }
  }, 50);

  const engineInfo = () => {
    const e = [];
    if (window.__THREE__) e.push('Three.js r' + window.__THREE__);
    if (window.Phaser) e.push('Phaser');
    if (window.PIXI) e.push('PixiJS');
    if (window.BABYLON) e.push('Babylon');
    return e.join(', ') || 'motor no detectado';
  };

  // ============================ Interfaz ============================
  const CSS = `
:host{all:initial}
#pb-panel{position:fixed;top:16px;right:16px;z-index:2147483647;width:390px;max-width:calc(100vw - 16px);max-height:calc(100vh - 32px);overflow:auto;font:12.5px/1.45 system-ui,'Segoe UI',sans-serif;color:#f2f0ff;background:#141026;border:1px solid #6a5cc0;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.55);user-select:none;text-align:left}
#pb-panel *{box-sizing:border-box}
#pb-panel .pb-head{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#2b2450;border-radius:10px 10px 0 0;cursor:move;font-weight:600;touch-action:none}
#pb-panel .badge{font-weight:400;font-size:11px;color:#fc6;margin-left:6px}
#pb-panel.mini .pb-body{display:none}
#pb-panel .pb-body{padding:8px 10px}
#pb-panel button,#pb-panel select{background:#3d3478;color:#fff;border:1px solid #5b4fa0;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit}
#pb-panel button:hover{background:#5244a0}
#pb-panel button.on,#pb-panel button.main{background:#ffcb05;color:#1a1630;border-color:#ffcb05;font-weight:600}
#pb-panel button.warn{background:#7a2e3a;border-color:#a33}
#pb-panel button.link{background:none;border:none;color:#9ec9ff;padding:0;text-decoration:underline}
#pb-panel button.sm{padding:2px 6px}
#pb-panel input,#pb-panel textarea{background:#0e0b1f;color:#fff;border:1px solid #5b4fa0;border-radius:6px;padding:4px 6px;font:inherit;user-select:text}
#pb-panel .row{display:flex;gap:4px;margin:5px 0;flex-wrap:wrap;align-items:center}
#pb-panel .row input{flex:1;min-width:0}
#pb-panel input.num{flex:none;width:72px}
#pb-panel .sp{flex:1}
#pb-panel .pb-tabs{display:flex;gap:3px;margin-bottom:6px}
#pb-panel .pb-tabs button{flex:1;padding:5px 1px;font-size:11.5px;white-space:nowrap}
#pb-panel section{display:none}
#pb-panel section.on{display:block}
#pb-panel .grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:6px 0}
#pb-panel .grid button{padding:7px 4px;font-size:12.5px}
#pb-panel .slot,#pb-panel .st{display:flex;align-items:center;gap:4px;padding:5px 6px;margin:3px 0;background:#211b3d;border:1px solid #3a3170;border-radius:8px;color:#f2f0ff}
#pb-panel .slot .nm{width:86px;font-weight:600;color:#fff}
#pb-panel .st .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pb-panel .slot.fz,#pb-panel .st.fz{background:#17375a;border-color:#3d7cc0}
#pb-panel .slot.miss .v{color:#8a86a8;font-size:11px}
#pb-panel .slot .v{font-size:14px;font-weight:600}
#pb-panel .slot input.num,#pb-panel .st input.num{width:64px}
#pb-panel .gt{margin:8px 0 2px;color:#ffcb05;font-weight:600}
#pb-panel .mrow{display:flex;align-items:center;gap:3px;padding:4px 6px;margin:3px 0;background:#211b3d;border:1px solid #3a3170;border-radius:8px}
#pb-panel .mrow.act{background:#3a2c0e;border-color:#c99a1a}
#pb-panel .mrow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:#fff}
#pb-panel .mrow .v{min-width:46px;font-size:12px}
#pb-panel .mrow button{padding:2px 5px;font-size:11.5px}
#pb-panel .mrow input.num{width:46px;padding:2px 4px}
#pb-panel .mrow.miss .v{color:#8a86a8}
#pb-panel .godrow{padding:4px 8px;background:#1d1838;border:1px solid #3a3170;border-radius:8px;margin:0 0 6px}
#pb-panel .godrow label{display:flex;align-items:center;gap:4px;margin-left:auto;color:#ddd}
#pb-panel .godrow input.num{width:60px}
#pb-panel .luck{margin:8px 0;padding:6px 8px;background:#1d2a1f;border:1px solid #3f7a4a;border-radius:8px}
#pb-panel .luck.fz{background:#17375a;border-color:#3d7cc0}
#pb-panel .luck.miss{opacity:.55}
#pb-panel .luck .nm{font-weight:600;color:#fff}
#pb-panel .luck .v.big{font-size:16px;font-weight:700;min-width:40px}
#pb-panel .luck .hint{margin-top:2px}
#pb-panel .chips{display:flex;gap:4px;margin:4px 0}
#pb-panel .chips button{flex:1}
#pb-panel .step{background:#221c40;border-left:3px solid #ffcb05;border-radius:6px;padding:7px 8px;margin:6px 0;font-size:12.5px}
#pb-panel .pb-prog{display:none;height:18px;background:#0e0b1f;border-radius:6px;overflow:hidden;position:relative;margin:4px 0}
#pb-panel .pb-prog.on{display:block}
#pb-panel .pb-prog i{position:absolute;inset:0;width:40%;background:linear-gradient(90deg,transparent,#5b4fa0,transparent);animation:pbmove 1.1s linear infinite}
#pb-panel .pb-prog span{position:relative;display:block;text-align:center;font-size:11px;line-height:18px}
@keyframes pbmove{from{left:-40%}to{left:100%}}
#pb-panel.busy section button{opacity:.45;pointer-events:none}
#pb-panel .pb-status{color:#ffcb05;margin:4px 0;word-break:break-word}
#pb-panel .pb-list{max-height:220px;overflow:auto;background:#0e0b1f;border-radius:6px;padding:2px}
#pb-panel .pb-list.tall{max-height:340px}
#pb-panel .pb-list:empty{display:none}
#pb-panel .item{display:flex;align-items:center;gap:4px;padding:3px 4px;border-bottom:1px solid #2b2450}
#pb-panel .p{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aaa;font-family:ui-monospace,monospace;font-size:11px}
#pb-panel .v{min-width:52px;text-align:right;color:#7fe0a0;font-family:ui-monospace,monospace}
#pb-panel .pin{padding:6px;border-bottom:1px solid #2b2450}
#pb-panel .pin.fz{background:#173a5a}
#pb-panel .pin .lbl{font-weight:600}
#pb-panel .pin .v{font-size:14px;min-width:60px}
#pb-panel .empty{padding:14px;text-align:center;color:#999}
#pb-panel #pb-editor{display:none;margin-top:6px}
#pb-panel #pb-editor.on{display:block}
#pb-panel textarea{width:100%;height:200px;font-family:ui-monospace,monospace;font-size:11px;line-height:15px;resize:vertical}
#pb-panel .hint{color:#b5b0d6;font-size:11.5px;margin-top:6px}
#pb-panel details{margin-top:8px}
#pb-panel summary{cursor:pointer;color:#ddd;font-weight:600}
#pb-panel .pb-toast{position:sticky;bottom:0;margin-top:6px;background:#2f6b45;color:#fff;padding:6px 8px;border-radius:6px;opacity:0;transition:opacity .2s;pointer-events:none}
#pb-panel .pb-toast.warn{background:#7a2e3a}
#pb-panel .pb-toast.on{opacity:1}`;

  const HELP_MISS = 'Entra a una partida y espera unos segundos: el trainer busca al jugador solo. Si no aparece, pulsa <b>🔍 Detectar</b>. Si aún así no, toca <b>buscar</b> junto al valor que quieras y sigue los pasos.';
  const HELP_MENU = 'El trainer está <b>conectado al juego</b>. Los valores aparecen cuando la partida ya empezó (después de pulsar <b>¡Empezar!</b>); en el menú y en la selección de Pokémon o región se ven como “—”.';
  const HELP_OK = '<b>❄</b> fija un valor para que el juego no lo cambie. Escribe un número y pulsa <b>Enter</b> o <b>✓</b> para ponerlo. La vida máx. y las estadísticas se recalculan al subir de nivel o tomar un objeto: usa <b>❄</b> para que se mantengan. Las partidas con trucos quedan en <b>modo práctica 🟠</b>: se juegan normal, pero no se envían al ranking.';

  const HTML = `<style>${CSS}</style>
<div class="pb-head"><span>⚡ PokéBonk Trainer<span id="pb-badge" class="badge"></span></span><span><button class="sm" data-a="min" title="Minimizar">–</button> <button class="sm" data-a="close" title="Ocultar (F2 para volver)">×</button></span></div>
<div class="pb-body">
  <div class="pb-tabs">
    <button data-tab="quick" class="on">⚡ Rápido</button>
    <button data-tab="search">🔎 Buscar</button>
    <button data-tab="pins">❄ Fijados<span id="pb-npins"></span></button>
    <button data-tab="saves">💾 Datos</button>
  </div>
  <div class="pb-prog" id="pb-prog"><i></i><span></span></div>

  <section data-pane="quick" class="on">
    <div class="row"><span class="pb-status" id="pb-qstatus"></span><span class="sp"></span><button data-a="detect">🔍 Detectar</button></div>
    <div class="grid">
      <button data-a="heal">❤ Curar</button>
      <button data-a="god" id="pb-god">🛡 Inmortal</button>
      <button data-a="addGold">💰 +1000 oro</button>
      <button data-a="addXp">⬆ Subir nivel</button>
    </div>
    <div class="row godrow" id="pb-godrow"><span>🛡 Vida mínima</span><input id="pb-godfloor" class="num" type="number" min="1" title="Con Inmortal, la vida nunca baja de este número, ni con un golpe enorme"><label title="Además de no bajar del mínimo, la vida se vuelve a llenar sola"><input type="checkbox" id="pb-godfill"> Rellenar vida</label></div>
    <div id="pb-slots"></div>
    <div class="luck" id="pb-luck">
      <div class="row"><span class="nm">🍀 Suerte</span><span class="v big" id="pb-luckv">—</span><span class="hint" id="pb-luckm"></span><span class="sp"></span><button class="sm" data-a="luckFz" id="pb-luckfz" title="Mantener la suerte aunque el juego la recalcule">❄ Mantener</button></div>
      <div class="row"><button data-a="luck10">+10</button><button data-a="luck50">+50</button><button data-a="luck100">+100</button><span class="sp"></span><input id="pb-lucki" class="num" type="number" placeholder="valor"><button class="sm" data-a="luckSet" title="Poner">✓</button></div>
      <div class="hint">Mejora la rareza de cofres y objetos. Hasta 100 también abarata cofres y mejora la tragamonedas. Se recalcula al subir de nivel o tomar un objeto: usa ❄ para mantenerla.</div>
    </div>
    <details id="pb-multbox" open><summary id="pb-multsum">✖ Multiplicadores</summary>
      <div id="pb-mults"></div>
      <div class="row"><span class="hint">Multiplican lo que calcula el juego y se mantienen al subir de nivel o tomar objetos. Escribe otro valor en la casilla “×” (ej. 3 o 0.5).</span></div>
      <div class="row"><span class="sp"></span><button class="warn sm" data-a="multReset">Quitar todos</button></div>
    </details>
    <details id="pb-statbox"><summary id="pb-statsum"></summary><div id="pb-stats"></div></details>
    <div class="hint" id="pb-qhelp"></div>
  </section>

  <section data-pane="search">
    <div class="chips" id="pb-chips"></div>
    <div class="step" id="pb-step"></div>
    <div class="row" id="pb-vrow"><input id="pb-val" type="number" placeholder="Número que ves en pantalla"><button class="main" data-a="go" id="pb-go">Buscar</button></div>
    <div class="row" id="pb-brow"><button data-a="down" id="pb-down"></button><button data-a="up" id="pb-up"></button><button data-a="same">😐 Igual</button></div>
    <div class="row"><button class="link" data-a="bar" id="pb-barlink">No veo el número (es una barra)</button><span class="sp"></span><button data-a="reset">↺ Empezar de nuevo</button></div>
    <div id="pb-res">
      <div class="row"><span>Valor nuevo</span><input id="pb-new" class="num" type="number" value="9999"><span class="sp"></span><button data-a="setall">✎ Poner en todos</button></div>
      <div class="pb-list" id="pb-list"></div>
    </div>
    <details><summary>🏷 Buscar por nombre de variable</summary>
      <div class="row"><input id="pb-re" placeholder="ej. gold, hp, luck (acepta regex)"><button class="main" data-a="find">Buscar</button></div>
      <div class="pb-status" id="pb-fstatus"></div>
      <div class="pb-list tall" id="pb-found"></div>
    </details>
  </section>

  <section data-pane="pins">
    <div class="pb-list tall" id="pb-pins"></div>
    <div class="hint">❄ Fijo mantiene el valor aunque el juego lo cambie. Se recuerdan al recargar; los que apuntan a Vida, Oro o a una estadística se reconectan solos en la siguiente partida.</div>
  </section>

  <section data-pane="saves">
    <div class="row"><span class="pb-status" id="pb-sstatus"></span><span class="sp"></span><button data-a="saves">↻</button></div>
    <div class="pb-list" id="pb-saves"></div>
    <div id="pb-editor">
      <div class="pb-status" id="pb-edkey"></div>
      <div class="row"><input id="pb-edfind" placeholder="Buscar en el texto (ej. volume) y pulsa Enter"></div>
      <textarea id="pb-ta" spellcheck="false"></textarea>
      <div class="row"><button class="main" data-a="saveReload">Guardar y recargar</button><button data-a="save">Solo guardar</button><span class="sp"></span><button data-a="cancel">Cerrar</button></div>
      <div class="row"><button data-a="dl">⬇ Descargar copia</button><button class="warn" data-a="restore" id="pb-restore">Restaurar original</button></div>
      <div class="pb-status" id="pb-edmsg"></div>
    </div>
    <div class="hint">Aquí solo están los datos que el juego guarda en tu navegador (ajustes, caché). Tu perfil (Polvo Estelar, desbloqueos) vive en el servidor.</div>
  </section>

  <div class="hint" id="pb-info"></div>
  <div class="pb-toast" id="pb-toast"></div>
</div>`;

  const S = { preset: 'vida', mode: 'idle', step: 1 }; // mode: idle | value | bar

  function uiPanel(show = true) {
    document.getElementById('pb-host')?.remove();
    clearInterval(window.__pbTick);

    const root = document.createElement('div');
    root.id = 'pb-panel';
    root.dataset.tab = 'quick';
    root.innerHTML = HTML;
    const pos = lsJSON(LS.pos, null);
    if (pos) Object.assign(root.style, {
      left: Math.min(Math.max(0, pos.l), innerWidth - 80) + 'px',
      top: Math.min(Math.max(0, pos.t), innerHeight - 40) + 'px',
      right: 'auto'
    });
    if (!show) root.style.display = 'none';
    // Shadow DOM: el CSS del juego (que tiene sus propias clases .slot, .item…) no entra aquí
    const host = document.createElement('div');
    host.id = 'pb-host';
    host.attachShadow({ mode: 'open' }).append(root);
    document.body.append(host);

    const $ = s => root.querySelector(s);
    const el = (tag, props = {}, ...kids) => {
      const { dataset, ...rest } = props;
      const e = Object.assign(document.createElement(tag), rest);
      if (dataset) Object.assign(e.dataset, dataset);
      kids.forEach(k => e.append(k));
      return e;
    };
    const fmt = x => x === undefined ? '—' : typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(2)) : String(x);
    const short = p => {
      const t = p.match(/\.get\("(?:[^"\\]|\\.)*"\)|\["(?:[^"\\]|\\.)*"\]|\.[^.[]+|^[^.[]+/g) || [p];
      return t.length > 3 ? '…' + t.slice(-3).join('') : p;
    };
    const num = inp => { const v = parseFloat(inp.value); return Number.isNaN(v) ? null : v; };
    const newVal = () => num($('#pb-new')) ?? 0;

    let toastT;
    const toast = (msg, warn) => {
      const t = $('#pb-toast');
      t.textContent = msg;
      t.className = 'pb-toast on' + (warn ? ' warn' : '');
      clearTimeout(toastT);
      toastT = setTimeout(() => t.classList.remove('on'), 2600);
    };
    const prog = $('#pb-prog');
    const progress = text => { prog.classList.toggle('on', !!text); if (text) prog.lastChild.textContent = text; };

    // ------------------------- Pestaña Rápido -------------------------
    const slotUI = {};
    for (const s of SLOTS) {
      const val = el('span', { className: 'v' });
      const inp = el('input', { type: 'number', className: 'num', placeholder: 'nuevo' });
      const put = () => {
        const r = slotRef(s.id);
        if (!r) return toast(`Primero hay que encontrar ${s.name}`, true);
        const v = num(inp);
        if (v === null) return toast('Escribe un número', true);
        if (!(s.id === 'level' && setLevel(v))) writeRef(r, v);
        const p = pins.find(x => x.fz && x.slot === s.id);
        if (p) { p.val = v; savePins(); }       // si estaba fijo, fija el nuevo valor
        inp.value = '';
        toast(`${s.icon} ${s.name} = ${v}`);
        tick();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') put(); });
      const fz = el('button', { className: 'sm', textContent: '❄', title: 'Fijar (el juego no lo podrá cambiar)', onclick: () => {
        const r = slotRef(s.id);
        if (!r) return toast(`Primero hay que encontrar ${s.name}`, true);
        const v = num(inp) ?? readRef(r);
        const on = toggleFreeze({ label: s.name, slot: s.id, path: r.p, val: v });
        toast(on ? `❄ ${s.name} fijo en ${fmt(v)}` : `${s.name} ya no está fijo`);
        renderQuick(); renderPins();
      } });
      const findBtn = el('button', { className: 'link', textContent: 'buscar', title: 'Encontrarlo a mano', onclick: () => {
        S.preset = s.preset; actions.reset(); switchTab('search');
      } });
      const row = el('div', { className: 'slot' },
        el('span', { className: 'nm', textContent: `${s.icon} ${s.name}` }), val, el('span', { className: 'sp' }), findBtn, inp,
        el('button', { className: 'sm', textContent: '✓', title: 'Poner', onclick: put }), fz);
      slotUI[s.id] = { row, val, fz, findBtn };
      $('#pb-slots').append(row);
    }

    const godFloorUI = () => (isNum(god.floor) && god.floor > 0 ? god.floor : 10);
    $('#pb-godfloor').value = godFloorUI();
    $('#pb-godfill').checked = god.fill !== false;
    $('#pb-godfloor').addEventListener('change', () => {
      const v = num($('#pb-godfloor'));
      god = { ...god, floor: v !== null && v >= 1 ? Math.round(v) : 10 };
      $('#pb-godfloor').value = godFloorUI();
      lsSet(LS.god, J(god));
      toast(`🛡 Vida mínima: ${godFloorUI()}`);
    });
    $('#pb-godfill').addEventListener('change', () => {
      god = { ...god, fill: $('#pb-godfill').checked };
      lsSet(LS.god, J(god));
      toast(god.fill ? '🛡 La vida se rellena sola' : '🛡 La vida baja normal, pero nunca del mínimo');
    });

    function renderQuick() {
      const ok = slotsOk();
      $('#pb-qstatus').textContent = hooked()
        ? (game() ? '✅ Conectado a la partida' : '🔗 Conectado · entra a una partida')
        : detecting ? '🔍 Buscando al jugador…'
        : ok ? '✅ Jugador encontrado'
        : inGame() ? '❓ Aún no encuentro al jugador'
        : '⏳ Entra a una partida';
      const g = $('#pb-god');
      g.classList.toggle('on', !!god.on);
      g.textContent = god.on ? '🛡 Inmortal: SÍ' : '🛡 Inmortal';
      $('#pb-qhelp').innerHTML = ok ? HELP_OK : hooked() ? HELP_MENU : HELP_MISS + (HOOK.why ? `<br><br>⚠ Modo limitado: ${HOOK.why}.` : '');
      for (const s of SLOTS) {
        const u = slotUI[s.id], r = slotRef(s.id), f = isFrozen({ slot: s.id });
        u.row.classList.toggle('miss', !r);
        u.row.classList.toggle('fz', f);
        u.fz.classList.toggle('on', f);
        u.findBtn.style.display = r || hooked() ? 'none' : '';
      }
      renderMults();
      const lf = isFrozen({ stat: 'luck' });
      $('#pb-luck').classList.toggle('fz', lf);
      $('#pb-luck').classList.toggle('miss', !luckRef());
      $('#pb-luckfz').classList.toggle('on', lf);
      $('#pb-luckfz').textContent = lf ? '❄ Fija' : '❄ Mantener';
      renderStats();
      tick();
    }

    // ------------------------- Multiplicadores -------------------------
    const multUI = [];
    {
      const box = $('#pb-mults');
      for (const [title, list] of MULTS) {
        box.append(el('div', { className: 'gt', textContent: title }));
        for (const [k, label] of list) {
          const val = el('span', { className: 'v' });
          const btns = [1, 2, 5, 10].map(m => el('button', { textContent: '×' + m, title: m === 1 ? 'Normal' : `Multiplicar ${label} por ${m}`, onclick: () => applyMultUI(k, label, m) }));
          const inp = el('input', { type: 'number', className: 'num', placeholder: '×', step: 'any', min: '0' });
          inp.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return;
            const m = num(inp);
            if (m === null || m <= 0) return toast('Escribe un número mayor que 0', true);
            applyMultUI(k, label, m);
            inp.value = '';
          });
          const row = el('div', { className: 'mrow', title: k }, el('span', { className: 'nm', textContent: label }), val, ...btns, inp);
          multUI.push({ k, row, val, btns, inp });
          box.append(row);
        }
      }
    }
    function applyMultUI(k, label, m) {
      const ok = setMult(k, m);
      const cur = mults[k] || 1;
      toast(cur === 1 ? `${label}: normal` : `✖ ${label} ×${cur}` + (ok ? '' : ' (se aplica al empezar la partida)'));
      renderMults();
      tick();
    }
    function renderMults() {
      let n = 0;
      for (const u of multUI) {
        const m = mults[u.k] || 1;
        if (m !== 1) n++;
        u.row.classList.toggle('act', m !== 1);
        u.btns.forEach((b, i) => b.classList.toggle('on', [1, 2, 5, 10][i] === m));
        u.inp.placeholder = [1, 2, 5, 10].includes(m) ? '×' : '×' + m;
      }
      $('#pb-multsum').textContent = n ? `✖ Multiplicadores (${n} activo${n > 1 ? 's' : ''})` : '✖ Multiplicadores';
    }

    let statsShown = null;
    const statUI = [];
    function renderStats() {
      const so = curStats() && curStats().o;
      let sig = '';
      try { sig = so ? Object.keys(so).filter(k => isNum(get(so, k))).join(',') : ''; } catch {}
      if (sig === statsShown) {
        statUI.forEach(u => { const f = isFrozen({ stat: u.k }); u.row.classList.toggle('fz', f); u.fz.classList.toggle('on', f); });
        return;
      }
      statsShown = sig;
      statUI.length = 0;
      const box = $('#pb-stats');
      box.textContent = '';
      if (!so) { $('#pb-statsum').textContent = '📊 Estadísticas (aún no encontradas)'; return; }
      const known = new Set(STAT_KEYS);
      const groups = STAT_GROUPS.map(([t, m]) => [t, Object.keys(m).filter(k => isNum(get(so, k)))]);
      let extra = [];
      try { extra = Object.keys(so).filter(k => !known.has(k) && isNum(get(so, k))); } catch {}
      if (extra.length) groups.push(['🔧 Otras', extra]);
      let total = 0;
      for (const [title, keys] of groups) {
        if (!keys.length) continue;
        box.append(el('div', { className: 'gt', textContent: title }));
        for (const k of keys) { total++; box.append(statRow(k)); }
      }
      $('#pb-statsum').textContent = `📊 Estadísticas (${total})`;
    }
    function statRow(k) {
      const label = STAT_LABEL[k] || k;
      const ref = () => curStats() ? { o: curStats().o, k } : null;
      const val = el('span', { className: 'v' });
      const inp = el('input', { type: 'number', className: 'num', placeholder: 'nuevo' });
      const put = () => {
        const v = num(inp), r = ref();
        if (v === null) return toast('Escribe un número', true);
        if (!r) return;
        writeRef(r, v);
        const p = pins.find(x => x.fz && x.stat === k);
        if (p) { p.val = v; savePins(); }
        inp.value = '';
        toast(`${label} = ${v}`);
        tick();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') put(); });
      const fz = el('button', { className: 'sm', textContent: '❄', title: 'Fijar', onclick: () => {
        const r = ref();
        if (!r) return;
        const v = num(inp) ?? readRef(r);
        const on = toggleFreeze({ label, stat: k, path: curStats().p + pathKey(k), val: v });
        toast(on ? `❄ ${label} fijo en ${fmt(v)}` : `${label} ya no está fijo`);
        renderStats(); renderPins();
      } });
      const dbl = el('button', { className: 'sm', textContent: '×2', title: 'Duplicar', onclick: () => {
        const r = ref(), c = r && readRef(r);
        if (isNum(c)) { writeRef(r, c === 0 ? 1 : c * 2); tick(); }
      } });
      const row = el('div', { className: 'st', title: k },
        el('span', { className: 'nm', textContent: label }), val, inp,
        el('button', { className: 'sm', textContent: '✓', title: 'Poner', onclick: put }), dbl, fz);
      statUI.push({ k, val, row, fz });
      return row;
    }

    // ------------------------- Pestaña Buscar -------------------------
    const chips = $('#pb-chips');
    for (const [key, P] of Object.entries(PRESETS)) {
      chips.append(el('button', { textContent: `${P.icon} ${P.name}`, dataset: { p: key }, onclick: () => { S.preset = key; renderSearch(); } }));
    }

    async function runScan(fn) {
      scanning = true;
      root.classList.add('busy');
      progress('Revisando…');
      try {
        await fn(n => progress(`Revisando… ${n.toLocaleString()} propiedades`));
      } finally {
        scanning = false;
        root.classList.remove('busy');
        progress(null);
      }
    }

    function renderSearch() {
      const P = PRESETS[S.preset];
      chips.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.p === S.preset));
      const n = cands.length;
      const what = P.name.toLowerCase();
      let msg;
      if (S.mode === 'idle') {
        msg = `<b>Paso 1.</b> ¿Cuánto <b>${what}</b> tienes ahora? Escribe el número que ves y pulsa <b>Buscar</b>.`;
      } else if (!n) {
        msg = `No quedó ningún candidato 😕 Pulsa <b>Empezar de nuevo</b>. Si se ve como barra, usa “No veo el número”.`;
      } else if (n > MAX_SHOWN) {
        msg = S.mode === 'value'
          ? `<b>Paso ${S.step}.</b> Hay <b>${n.toLocaleString()}</b> posibles. En el juego <b>${P.act}</b>, escribe el número nuevo y pulsa <b>Filtrar</b>.`
          : `<b>Paso ${S.step}.</b> Hay <b>${n.toLocaleString()}</b> posibles. En el juego <b>${P.act}</b> y pulsa el botón que diga qué pasó.`;
      } else if (n > 3) {
        msg = `<b>Paso ${S.step}.</b> Quedan <b>${n}</b>. Repite una vez más para afinar.`;
      } else {
        msg = P.slot
          ? `<b>¡Encontrado!</b> Pulsa <b>✔ Es este</b> y lo tendrás en ⚡ Rápido (también para Curar / Inmortal / +oro).`
          : `<b>¡Encontrado!</b> <b>✎</b> pone el “Valor nuevo” · <b>❄</b> lo deja fijo.`;
      }
      $('#pb-step').innerHTML = msg;
      $('#pb-go').textContent = S.mode === 'idle' ? 'Buscar' : 'Filtrar';
      $('#pb-vrow').style.display = S.mode === 'bar' ? 'none' : '';
      $('#pb-brow').style.display = S.mode === 'bar' && n ? '' : 'none';
      $('#pb-down').textContent = P.down;
      $('#pb-up').textContent = P.up;
      $('#pb-barlink').style.display = S.mode === 'idle' ? '' : 'none';
      $('#pb-res').style.display = n && n <= MAX_SHOWN ? '' : 'none';
      renderCands();
    }

    function renderCands() {
      const list = $('#pb-list');
      list.textContent = '';
      if (!cands.length || cands.length > MAX_SHOWN) return;
      const P = PRESETS[S.preset];
      cands.forEach(c => {
        c._view = el('span', { className: 'v' });
        const kids = [el('span', { className: 'p', textContent: short(c.p), title: c.p }), c._view];
        if (P.slot) kids.push(el('button', { className: 'main sm', textContent: '✔ Es este', title: `Usar como ${SLOT[P.slot].name} en ⚡ Rápido`, onclick: () => {
          setSlot(P.slot, c, true);
          toast(`✔ ${SLOT[P.slot].name} conectada a ⚡ Rápido`);
          switchTab('quick');
        } }));
        kids.push(el('button', { className: 'sm', textContent: '✎', title: 'Poner el “Valor nuevo”', onclick: () => { writeRef(c, newVal()); tick(); } }));
        kids.push(el('button', { className: 'sm', textContent: '❄', title: 'Dejar fijo en el “Valor nuevo”', onclick: () => {
          addPin({ label: P.name, path: c.p, ref: c, val: newVal(), fz: true });
          toast(`❄ ${P.name} fijo en ${newVal()}`);
          renderPins();
        } }));
        list.append(el('div', { className: 'item' }, ...kids));
      });
      tick();
    }

    async function renderFind() {
      const box = $('#pb-found');
      box.textContent = '';
      let re;
      try { re = new RegExp($('#pb-re').value || '.^', 'i'); }
      catch { $('#pb-fstatus').textContent = 'Expresión inválida'; return; }
      $('#pb-fstatus').textContent = 'Buscando…';
      root.classList.add('busy');
      let res;
      try { res = await find(re); } finally { root.classList.remove('busy'); }
      $('#pb-fstatus').textContent = res.length ? `${res.length} resultado(s)` : 'Nada encontrado. Entra a una partida e inténtalo de nuevo.';
      res.forEach(r => {
        const x = readRef(r);
        const val = el('span', { className: 'v', textContent: fmt(describe(x)) });
        const kids = [el('span', { className: 'p', textContent: short(r.p), title: r.p }), val];
        if (typeof x === 'number') {
          const sel = el('select', { title: 'Conectar a ⚡ Rápido' }, el('option', { value: '', textContent: 'usar como…' }),
            ...SLOTS.map(s => el('option', { value: s.id, textContent: `${s.icon} ${s.name}` })));
          sel.onchange = () => {
            if (!sel.value) return;
            setSlot(sel.value, r, true);
            toast(`✔ ${SLOT[sel.value].name} conectada a ⚡ Rápido`);
            sel.value = '';
          };
          kids.push(sel);
          kids.push(el('button', { className: 'sm', textContent: '✎', title: 'Poner el “Valor nuevo”', onclick: () => { writeRef(r, newVal()); val.textContent = fmt(readRef(r)); } }));
          kids.push(el('button', { className: 'sm', textContent: '❄', title: 'Fijar en el “Valor nuevo”', onclick: () => {
            addPin({ label: r.k, path: r.p, ref: r, val: newVal(), fz: true });
            toast(`❄ ${r.k} fijo en ${newVal()}`); renderPins();
          } }));
        }
        if (Array.isArray(x) && x.length) {
          kids.push(el('button', { className: 'sm', textContent: '+1', title: 'Duplicar el primer elemento', onclick: () => {
            PB.dup(x, 0); markDirty(); val.textContent = `Array(${x.length})`;
          } }));
        }
        kids.push(el('button', { className: 'sm', textContent: '👁', title: 'Mostrar en consola', onclick: () => { console.log(r.p, readRef(r)); toast('Mostrado en la consola (F12)'); } }));
        box.append(el('div', { className: 'item' }, ...kids));
      });
    }

    // ------------------------- Pestaña Fijados -------------------------
    function renderPins() {
      $('#pb-npins').textContent = pins.length ? ` (${pins.length})` : '';
      const box = $('#pb-pins');
      box.textContent = '';
      if (!pins.length) {
        box.append(el('div', { className: 'empty', textContent: 'Aún no hay valores fijados. Pulsa ❄ en ⚡ Rápido o en 🔎 Buscar.' }));
        return;
      }
      pins.forEach((p, i) => {
        const label = el('input', { className: 'lbl', value: p.label || '', onchange: () => { p.label = label.value; savePins(); } });
        p._view = el('span', { className: 'v' });
        const val = el('input', { type: 'number', className: 'num', value: p.val });
        const readVal = () => { const v = num(val); p.val = v ?? 0; savePins(); };
        val.onchange = readVal;
        const where = p.slot ? `⚡ ${SLOT[p.slot]?.name || p.slot}` : p.stat ? `📊 ${p.stat}` : p.path;
        box.append(el('div', { className: 'pin' + (p.fz ? ' fz' : '') },
          el('div', { className: 'row' }, label, p._view),
          el('div', { className: 'row' },
            val,
            el('button', { textContent: 'Poner', onclick: () => {
              readVal();
              toast(pinWrite(p, p.val) ? `✎ ${p.label} = ${p.val}` : 'No lo encuentro (¿empezó otra partida? pulsa 🔍 Detectar)', !pinRef(p));
              tick();
            } }),
            el('button', { className: p.fz ? 'on' : '', textContent: p.fz ? '❄ Fijo' : '❄ Fijar', onclick: () => {
              readVal(); p.fz = !p.fz; savePins(); renderPins(); renderQuick();
            } }),
            el('span', { className: 'sp' }),
            el('button', { className: 'warn', textContent: '🗑', title: 'Borrar', onclick: () => { pins.splice(i, 1); savePins(); renderPins(); renderQuick(); } })
          ),
          el('div', { className: 'p', textContent: where, title: p.path || '' })
        ));
      });
      tick();
    }

    // ------------------------- Pestaña Datos -------------------------
    const gameKeys = () => {
      const ks = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith('pb:')) ks.push(k);
      }
      return ks;
    };
    function renderSaves() {
      const box = $('#pb-saves');
      box.textContent = '';
      const ks = gameKeys();
      $('#pb-sstatus').textContent = ks.length ? `${ks.length} dato(s) guardados por el juego` : 'El juego no usa localStorage.';
      ks.forEach(k => {
        const bak = lsGet(LS.bak + k) !== null;
        box.append(el('div', { className: 'item' },
          el('span', { className: 'p', textContent: k + (bak ? '  (con copia)' : ''), title: k }),
          el('span', { className: 'v', textContent: (lsGet(k) || '').length + ' c' }),
          el('button', { className: 'sm', textContent: 'Editar', onclick: () => openEditor(k) })
        ));
      });
    }
    function openEditor(k) {
      const raw = lsGet(k) || '';
      const ta = $('#pb-ta');
      let txt = raw, isJson = false;
      try { txt = J(JSON.parse(raw), null, 2); isJson = true; } catch {}
      ta.value = txt;
      ta.dataset.key = k;
      ta.dataset.json = isJson ? '1' : '0';
      $('#pb-edkey').textContent = k + (isJson ? ' (JSON)' : '');
      $('#pb-edmsg').textContent = '';
      $('#pb-restore').style.display = lsGet(LS.bak + k) !== null ? '' : 'none';
      $('#pb-editor').classList.add('on');
    }
    function writeSave() {
      const ta = $('#pb-ta');
      const k = ta.dataset.key;
      let v = ta.value;
      if (ta.dataset.json === '1') {
        try { v = J(JSON.parse(v)); }
        catch (e) { $('#pb-edmsg').textContent = 'JSON inválido: ' + e.message; return false; }
      }
      if (lsGet(LS.bak + k) === null) lsSet(LS.bak + k, lsGet(k) || '');   // copia del original, solo la primera vez
      lsSet(k, v);
      $('#pb-restore').style.display = '';
      $('#pb-edmsg').textContent = 'Guardado. Recarga la página para aplicarlo (o usa “Guardar y recargar”).';
      return true;
    }
    const reloadKeeping = k => { blocked.add(k); location.reload(); };
    $('#pb-edfind').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const ta = $('#pb-ta'), q = e.target.value.toLowerCase();
      if (!q) return;
      const txt = ta.value.toLowerCase();
      let idx = txt.indexOf(q, ta.selectionEnd);
      if (idx < 0) idx = txt.indexOf(q);
      if (idx < 0) { $('#pb-edmsg').textContent = `“${e.target.value}” no aparece`; return; }
      ta.focus();
      ta.setSelectionRange(idx, idx + q.length);
      const line = ta.value.slice(0, idx).split('\n').length - 1;
      ta.scrollTop = Math.max(0, line * 15 - 60);
      e.target.focus();
    });

    // ------------------------- Acciones -------------------------
    const luckRef = () => { const st = curStats(); return st && isNum(get(st.o, 'luck')) ? { o: st.o, k: 'luck' } : null; };
    const setLuck = v => {
      const r = luckRef();
      if (!r) { toast('Entra a una partida primero', true); return false; }
      v = Math.max(0, v);
      writeRef(r, v);
      const p = pins.find(x => x.fz && x.stat === 'luck');
      if (p) { p.val = v; savePins(); }   // si está fija, se fija el valor nuevo
      tick();
      return true;
    };
    const addLuck = n => { const r = luckRef(); if (r && setLuck(readRef(r) + n)) toast(`🍀 Suerte ${fmt(readRef(r))}`); else if (!r) toast('Entra a una partida primero', true); };

    const addTo = (id, amount) => {
      const r = slotRef(id);
      if (!r) return toast(`No encontré ${SLOT[id].name}. Toca “buscar” junto a ${SLOT[id].name}.`, true);
      const cur = readRef(r);
      writeRef(r, cur + amount);
      toast(`${SLOT[id].icon} ${SLOT[id].name}: ${fmt(cur)} → ${fmt(cur + amount)}`);
      tick();
    };

    const actions = {
      detect: async () => {
        const res = await runDetect();
        if (!res) return;
        toast(res.player ? '✅ Jugador encontrado' : 'No lo encontré. ¿Estás dentro de una partida?', !res.player);
      },
      heal: () => {
        const r = slotRef('hp');
        if (!r) return toast('No encontré la Vida. Toca “buscar” junto a Vida.', true);
        const mx = slotVal('maxHp');
        if (!isNum(mx) || mx <= 0) return toast('No encontré la vida máxima: escribe el valor en Vida y pulsa ✓', true);
        writeRef(r, mx);
        toast(`❤ Vida al máximo (${fmt(mx)})`);
        tick();
      },
      god: () => {
        if (!god.on) {
          const r = slotRef('hp');
          if (!r) return toast('Primero hay que encontrar la Vida', true);
          const cur = readRef(r);
          god = { ...god, on: true, val: isNum(cur) ? cur : 9999 };
          markDirty();
          { const run = game(); if (run && run.player) guardHp(run.player); }
          toast(god.fill !== false ? `🛡 Inmortal: vida llena y nunca menos de ${godFloorUI()}` : `🛡 Inmortal: la vida nunca baja de ${godFloorUI()}`);
        } else {
          god = { ...god, on: false };
          toast('🛡 Inmortal desactivado');
        }
        lsSet(LS.god, J(god));
        renderQuick();
      },
      addGold: () => addTo('gold', 1000),
      multReset: () => {
        mults = {};
        saveMults();
        refreshStats();
        toast('Multiplicadores quitados');
        renderMults();
        tick();
      },
      luck10: () => addLuck(10),
      luck50: () => addLuck(50),
      luck100: () => addLuck(100),
      luckSet: () => {
        const v = num($('#pb-lucki'));
        if (v === null) return toast('Escribe un número', true);
        if (setLuck(v)) { $('#pb-lucki').value = ''; toast(`🍀 Suerte = ${v}`); }
      },
      luckFz: () => {
        const r = luckRef();
        if (!r) return toast('Entra a una partida primero', true);
        const on = toggleFreeze({ label: 'Suerte', stat: 'luck', path: curStats().p + '.luck', val: readRef(r) });
        toast(on ? `❄ Suerte fija en ${fmt(readRef(r))}` : 'La suerte ya no está fija');
        renderQuick(); renderStats(); renderPins();
      },
      addXp: () => {
        if (levelUp(1)) return toast('⬆ +1 nivel (elige tu carta)');
        addTo('xp', 500);
      },
      go: async () => {
        if (scanning) return;
        const inp = $('#pb-val');
        const v = num(inp);
        if (v === null) { toast('Escribe el número que ves en el juego', true); inp.focus(); return; }
        if (S.mode === 'idle') { await runScan(cb => scanValue(v, cb)); S.mode = 'value'; }
        else refilter(x => near(x, v));
        S.step++;
        inp.value = '';
        inp.focus();
        renderSearch();
      },
      bar: async () => {
        if (scanning) return;
        await runScan(snapAll);
        S.mode = 'bar'; S.step = 2;
        renderSearch();
      },
      down: () => { refilter((x, l) => x < l); S.step++; renderSearch(); },
      up: () => { refilter((x, l) => x > l); S.step++; renderSearch(); },
      same: () => { refilter((x, l) => x === l); S.step++; renderSearch(); },
      reset: () => { cands = []; S.mode = 'idle'; S.step = 1; renderSearch(); $('#pb-val').focus(); },
      setall: () => {
        if (cands.length > MAX_SHOWN) return toast('Primero filtra hasta que queden pocos', true);
        cands.forEach(c => writeRef(c, newVal()));
        toast(`✎ Puesto ${newVal()} en ${cands.length} lugar(es)`);
        tick();
      },
      find: () => renderFind(),
      saves: renderSaves,
      save: writeSave,
      saveReload: () => { if (writeSave()) reloadKeeping($('#pb-ta').dataset.key); },
      restore: () => {
        const k = $('#pb-ta').dataset.key, bak = lsGet(LS.bak + k);
        if (bak === null || !confirm(`¿Restaurar “${k}” a como estaba antes de editarlo? La página se recargará.`)) return;
        lsSet(k, bak);
        lsDel(LS.bak + k);
        reloadKeeping(k);
      },
      dl: () => {
        const ta = $('#pb-ta');
        const a = el('a', {
          href: URL.createObjectURL(new Blob([ta.value], { type: 'application/json' })),
          download: `pokebonk-${ta.dataset.key}-${new Date().toISOString().slice(0, 10)}.json`
        });
        document.body.append(a); a.click(); a.remove();
      },
      cancel: () => $('#pb-editor').classList.remove('on'),
      min: () => root.classList.toggle('mini'),
      close: () => { root.style.display = 'none'; lsSet(LS.hidden, '1'); },
    };

    function switchTab(name) {
      root.dataset.tab = name;
      root.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
      root.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('on', p.dataset.pane === name));
      if (name === 'quick') renderQuick();
      if (name === 'search') renderSearch();
      if (name === 'pins') renderPins();
      if (name === 'saves') renderSaves();
    }

    root.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (b) actions[b.dataset.a]?.();
      const t = e.target.closest('button[data-tab]');
      if (t) switchTab(t.dataset.tab);
    });
    root.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'pb-val') actions.go();
      if (e.target.id === 'pb-re') actions.find();
    });

    // Que el juego no reciba teclas ni clics hechos sobre el panel
    ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu', 'touchstart']
      .forEach(t => root.addEventListener(t, e => e.stopPropagation()));

    // Arrastrar desde la barra superior (y recordar la posición)
    const head = $('.pb-head');
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const r = root.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = ev => {
        root.style.left = Math.max(0, ev.clientX - dx) + 'px';
        root.style.top = Math.max(0, ev.clientY - dy) + 'px';
        root.style.right = 'auto';
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        const nr = root.getBoundingClientRect();
        lsSet(LS.pos, J({ l: nr.left | 0, t: nr.top | 0 }));
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });

    // F2 para mostrar/ocultar (se registra una sola vez)
    if (!window.__pbKey) {
      window.__pbKey = true;
      window.addEventListener('keydown', e => {
        if (e.key !== 'F2') return;
        e.preventDefault();
        const h = document.getElementById('pb-host');
        const p = h && h.shadowRoot && h.shadowRoot.getElementById('pb-panel');
        if (!p) return PB.ui();
        const showIt = p.style.display === 'none';
        p.style.display = showIt ? '' : 'none';
        lsSet(LS.hidden, showIt ? '0' : '1');
        if (showIt && document.pointerLockElement) document.exitPointerLock?.();
      }, true);
    }

    // Valores en vivo
    function tick() {
      if (cands.length <= MAX_SHOWN) cands.forEach(c => { if (c._view) c._view.textContent = fmt(readRef(c)); });
      pins.forEach(p => { if (p._view) p._view.textContent = fmt(pinRead(p)); });
      for (const s of SLOTS) { const r = slotRef(s.id); slotUI[s.id].val.textContent = r ? fmt(readRef(r)) : hooked() ? '—' : 'no encontrado'; }
      { const st = curStats(); for (const u of multUI) { const x = st ? get(st.o, u.k) : undefined; u.val.textContent = isNum(x) ? fmt(x) : '—'; u.row.classList.toggle('miss', !isNum(x)); } }
      const lr = luckRef();
      $('#pb-luckv').textContent = lr ? fmt(readRef(lr)) : '—';
      $('#pb-luckm').textContent = lr && isNum(lr.o.luckMult) ? `×${lr.o.luckMult.toFixed(2)}` : '';
      if ($('#pb-statbox').open) statUI.forEach(u => { u.val.textContent = curStats() ? fmt(get(curStats().o, u.k)) : '—'; });
      const b = $('#pb-badge');
      b.textContent = dirty ? ' 🟠 práctica' : '';
      b.title = dirty ? `Esta partida usa trucos: no se envía al ranking${blockedSends ? ` (${blockedSends} envío(s) detenidos)` : ''}` : '';
      $('#pb-info').textContent = `${engineInfo()} · ${roots.size + lives.length} fuente(s) capturada(s) · F2 muestra/oculta`;
    }
    let quickN = 0;
    window.__pbTick = setInterval(() => {
      if (!root.isConnected || root.style.display === 'none') return;
      tick();
      if (root.dataset.tab === 'quick' && ++quickN % 5 === 0) renderQuick();   // refresca el estado cada 2 s
    }, 400);

    renderQuick();
    renderSearch();
    renderPins();
    return { renderQuick, renderSearch, renderPins, progress, toast };
  }

  // ============================ Ganchos ============================
  const blocked = new Set();   // claves que el juego no debe sobrescribir antes de recargar
  let lastObj = null, lastStr = null;

  function installHooks() {
    // Recordar el último objeto convertido a JSON para reconocerlo al guardarse
    JSON.stringify = function (v, ...rest) {
      const s = J(v, ...rest);
      if (v && typeof v === 'object' && typeof s === 'string' && s.length > 20) { lastObj = v; lastStr = s; }
      return s;
    };

    Storage.prototype.setItem = function (k, v) {
      if (this === localStorage) {
        if (blocked.has(k)) return;
        if (lastObj && v === lastStr) capture('save:' + k, lastObj);
      }
      return _setItem.call(this, k, v);
    };

    if (window.IDBObjectStore) {
      for (const m of ['put', 'add']) {
        const orig = IDBObjectStore.prototype[m];
        IDBObjectStore.prototype[m] = function (val, key) {
          try { capture(`idb:${this.name}` + (key !== undefined ? ':' + String(key) : ''), val); } catch {}
          return orig.apply(this, arguments);
        };
      }
    }

    // Objetos con pinta de jugador que el juego guarda en Map/Set
    Map.prototype.set = function (k, v) {
      if (v !== null && typeof v === 'object') grabLive(v);
      return _mapSet.call(this, k, v);
    };
    Set.prototype.add = function (v) {
      if (v !== null && typeof v === 'object') grabLive(v);
      return _setAdd.call(this, v);
    };

    // three.js avisa a sus devtools cada vez que crea una escena
    try {
      const dt = window.__THREE_DEVTOOLS__ || (window.__THREE_DEVTOOLS__ = new EventTarget());
      let ns = 0;
      dt.addEventListener('observe', e => {
        if (e.detail && e.detail.isScene) { capture('scene#' + (++ns), e.detail); scheduleDetect(4000); }
      });
    } catch {}

    // Modo práctica: no enviar partidas con trucos
    if (window.fetch) {
      const _fetch = window.fetch;
      window.fetch = function (input, init) {
        const method = (init && init.method) || (input && input.method) || 'GET';
        const v = netCheck(input, method);
        if (v === 'block') {
          return Promise.reject(new TypeError('[PB] Partida con trucos: no se envía al servidor'));
        }
        const pr = _fetch.apply(this, arguments);
        if (v === 'start') {
          pr.then(res => { try { res.clone().json().then(j => gotRunId(j && j.id)).catch(() => {}); } catch {} }, () => {});
        }
        return pr;
      };
    }
    if (window.XMLHttpRequest) {
      const _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__pbM = m; this.__pbU = u; return _open.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        const v = netCheck(this.__pbU, this.__pbM);
        if (v === 'block') {
          setTimeout(() => { this.dispatchEvent(new ProgressEvent('error')); this.dispatchEvent(new ProgressEvent('loadend')); });
          return;
        }
        if (v === 'start') this.addEventListener('load', () => { try { gotRunId(JSON.parse(this.responseText).id); } catch {} });
        return _send.apply(this, arguments);
      };
    }
    if (navigator.sendBeacon) {
      const _beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (u, data) {
        if (netCheck(u, 'POST') === 'block') return false;
        return _beacon(u, data);
      };
    }
  }

  // ============================ API de consola ============================
  const report = () => {
    console.log(`%c[PB] ${cands.length} candidato(s)`, 'color:#6cf;font-weight:bold');
    if (ui) ui.renderSearch();
  };
  const PB = {
    __v: 3,
    roots, lives, slots,
    get stats() { return curStats(); },
    get cands() { return cands; },
    get pins() { return pins; },
    get practica() { return dirty; },
    get mults() { return { ...mults }; },
    mult: (k, m) => setMult(k, m),               // PB.mult('damage', 5)
    get app() { return window.__pbApp; },       // PB.app.run.player…
    get run() { return game(); },
    hook: HOOK,
    detect: () => runDetect(),
    val: id => slotVal(id),                       // PB.val('hp')
    setSlot(id, path) {                           // PB.setSlot('gold', 'root("live#2").gold')
      const r = resolve(path);
      if (!r || !SLOT[id]) return console.warn('[PB] slot o ruta no válida');
      setSlot(id, r, true);
      if (ui) ui.renderQuick();
    },
    resolve,
    async scan(v) { await scanValue(v); S.mode = 'value'; S.step = 2; report(); },
    async snap() { await snapAll(); S.mode = 'bar'; S.step = 2; report(); },
    next(v) { refilter(x => near(x, v)); report(); },
    down() { refilter((x, l) => x < l); report(); },
    up() { refilter((x, l) => x > l); report(); },
    same() { refilter((x, l) => x === l); report(); },
    diff() { refilter((x, l) => x !== l); report(); },
    list(max = 50) { console.table(cands.slice(0, max).map((c, i) => ({ i, ruta: c.p, valor: readRef(c) }))); },
    set(v, i) {
      const sel = i === undefined ? cands : [cands[i]];
      sel.forEach(c => writeRef(c, v));
      console.log(`[PB] escrito ${v} en ${sel.length} ubicación(es)`);
    },
    async find(re, max = 150) {
      const out = await find(re, max);
      console.table(out.map(r => ({ ruta: r.p, valor: describe(readRef(r)) })));
      return out;
    },
    dup(arr, i = 0, overrides = {}) {
      const src = arr[i];
      const copy = (src && typeof src === 'object')
        ? Object.assign(Object.create(Object.getPrototypeOf(src)), src, overrides)
        : src;
      arr.push(copy);
      markDirty();
      return copy;
    },
    saves() {
      const rows = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i), v = localStorage.getItem(k) || '';
        let tipo = 'texto';
        try { JSON.parse(v); tipo = 'JSON'; } catch {}
        rows.push({ clave: k, tipo, tamaño: v.length, inicio: v.slice(0, 80) });
      }
      console.table(rows);
    },
    ui() { lsSet(LS.hidden, '0'); ui = uiPanel(true); },
  };
  window.PB = PB;

  installHooks();

  const start = () => {
    ui = uiPanel(lsGet(LS.hidden) !== '1');
    console.log(`%c[PB] Trainer v3.4 listo (${HOOK.ok ? 'enganchado al juego' : 'modo limitado'}). F2 muestra/oculta; PB.ui() lo vuelve a abrir.`, 'color:#fc6');
    if (inGame()) scheduleDetect(1000);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();