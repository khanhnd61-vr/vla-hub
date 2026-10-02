// VLA Hub: search and compare measured VLA latency across engines and hardware.
// Data: window.VLA_META (data/meta.js) and window.VLA_BENCH (data/bench.js).
(() => {
  'use strict';

  const META = window.VLA_META;
  const BENCH = window.VLA_BENCH;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const ENGINES = Object.keys(META.engines);
  const ENGINE_CLASS = { 'vla.cpp': 'cpp', 'vla.simd': 'simd' };
  const MODEL_IDS = Object.keys(META.models);
  const DEVICE_IDS = Object.keys(META.devices);
  const MODEL_RANK = Object.fromEntries(MODEL_IDS.map((id, i) => [id, i]));
  const DEVICE_RANK = Object.fromEntries(DEVICE_IDS.map((id, i) => [id, i]));
  const PROC_RANK = { GPU: 0, NPU: 1, CPU: 2 };
  const REALTIME = 30; // actions per second, a 30 Hz control loop
  const PAGE = 60;
  const LOG_MAX = Math.log10(20000); // latency strip spans 1 ms to 20 s

  // ---------- Formatting ----------
  const num = (n, min, max = min) => n.toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
  const fmtMs = (ms) => (ms < 10 ? num(ms, 1, 2) : ms < 100 ? num(ms, 1) : num(ms, 0));
  const fmtRate = (r) => (r < 10 ? num(r, 1) : num(r, 0));
  const fmtMiB = (m) => (m >= 1024 ? `${num(m / 1024, 1)} GiB` : `${num(m, 0)} MiB`);
  const norm = (s) => String(s).toLowerCase().replace(/π/g, 'pi').replace(/[^a-z0-9]+/g, '');

  // Build an element; text always goes in through textContent.
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const link = (href, text, cls) => {
    const a = el('a', cls, text);
    a.href = href;
    if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
    return a;
  };
  const engChip = (engine, tag = 'span') => el(tag, `eng eng--${ENGINE_CLASS[engine]}`, engine);

  // ---------- Rows ----------
  const ROWS = BENCH.results.map((r, i) => {
    const model = META.models[r.model];
    const device = META.devices[r.device];
    const spec = model.engines[r.engine];
    const mem = r.mem || {};
    const hay = [
      model.name, r.model, model.by, ...(model.aliases || []), r.engine,
      device.name, device.short, device.kind, ...(device.aliases || []),
      r.unit, r.backend, r.proc, r.setup, r.config, r.flags || '',
    ].map(norm).join('|');
    return {
      ...r, i, m: model, d: device, spec, hay,
      key: `${r.engine}|${r.model}|${r.device}|${r.proc}`,
      hw: `${r.unit} · ${r.backend}`,
      rate: spec.chunk / (r.ms / 1000),
      memMain: mem.vram ?? mem.shared ?? mem.rss ?? null,
    };
  });

  const bestPerKey = (rows) => {
    const best = new Map();
    for (const r of rows) {
      const b = best.get(r.key);
      if (!b || r.ms < b.ms) best.set(r.key, r);
    }
    return rows.filter((r) => best.get(r.key) === r);
  };

  // Exact model names and aliases narrow the search to those models.
  const MODEL_ALIAS = new Map();
  for (const [id, m] of Object.entries(META.models)) {
    for (const a of [id, m.name, ...(m.aliases || [])]) {
      const k = norm(a);
      if (!MODEL_ALIAS.has(k)) MODEL_ALIAS.set(k, new Set());
      MODEL_ALIAS.get(k).add(id);
    }
  }
  const parseQuery = (q) => {
    const tokens = [];
    let models = null;
    for (const t of q.split(/\s+/).map(norm).filter(Boolean)) {
      if (MODEL_ALIAS.has(t)) {
        models = models || new Set();
        MODEL_ALIAS.get(t).forEach((id) => models.add(id));
      } else tokens.push(t);
    }
    return { tokens, models };
  };

  // ---------- State, kept in the URL so a search can be shared ----------
  const DEFAULTS = { q: '', engine: 'all', proc: 'all', model: 'all', device: 'all', rt: false, all: false, sort: 'model' };
  const SORTS = {
    model: (a, b) => MODEL_RANK[a.model] - MODEL_RANK[b.model] || a.ms - b.ms,
    device: (a, b) => DEVICE_RANK[a.device] - DEVICE_RANK[b.device] || PROC_RANK[a.proc] - PROC_RANK[b.proc] || a.ms - b.ms,
    latency: (a, b) => a.ms - b.ms,
    rate: (a, b) => b.rate - a.rate,
    memory: (a, b) => (a.memMain ?? Infinity) - (b.memMain ?? Infinity) || a.ms - b.ms,
  };
  const VALID = {
    engine: ['all', ...ENGINES], proc: ['all', 'GPU', 'NPU', 'CPU'],
    model: ['all', ...MODEL_IDS], device: ['all', ...DEVICE_IDS], sort: Object.keys(SORTS),
  };
  let state = { ...DEFAULTS };
  let limit = PAGE;
  const open = new Set();

  const readURL = () => {
    const p = new URLSearchParams(location.search);
    const s = { ...DEFAULTS };
    if (p.has('q')) s.q = p.get('q').slice(0, 120);
    for (const k of Object.keys(VALID)) if (VALID[k].includes(p.get(k))) s[k] = p.get(k);
    s.rt = p.get('rt') === '1';
    s.all = p.get('all') === '1';
    return s;
  };
  const writeURL = () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) {
      if (v === DEFAULTS[k]) continue;
      p.set(k, typeof v === 'boolean' ? '1' : v);
    }
    const qs = p.toString();
    try { history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash); } catch (e) { /* file:// in some browsers */ }
  };

  const filtered = () => {
    const { tokens, models } = parseQuery(state.q);
    const rows = ROWS.filter((r) =>
      (state.engine === 'all' || r.engine === state.engine) &&
      (state.proc === 'all' || r.proc === state.proc) &&
      (state.model === 'all' || r.model === state.model) &&
      (state.device === 'all' || r.device === state.device) &&
      (!state.rt || r.rate >= REALTIME) &&
      (!models || models.has(r.model)) &&
      tokens.every((t) => r.hay.includes(t)));
    return (state.all ? rows : bestPerKey(rows)).sort(SORTS[state.sort]);
  };

  // ---------- Tooltip (charts) ----------
  const tip = $('#tip');
  const showTip = (data, x, y) => {
    tip.replaceChildren();
    tip.append(el('div', 'tip__value', data.value));
    for (const line of data.lines) {
      const row = el('div', 'tip__row');
      if (line.c) { const k = el('i'); k.style.setProperty('--c', `var(--${line.c})`); row.append(k); }
      row.append(document.createTextNode(line.text));
      tip.append(row);
    }
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.min(x + 14, window.innerWidth - w - 8);
    const top = y + h + 20 > window.innerHeight ? y - h - 12 : y + 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  };
  const hideTip = () => { tip.hidden = true; };
  const bindTips = (root) => {
    const find = (t) => t.closest && t.closest('.bbar__fill');
    root.addEventListener('pointermove', (e) => {
      const b = find(e.target);
      if (b && b._tip) showTip(b._tip, e.clientX, e.clientY); else hideTip();
    });
    root.addEventListener('pointerleave', hideTip);
    root.addEventListener('focusin', (e) => {
      const b = find(e.target);
      if (!b || !b._tip) return;
      const r = b.getBoundingClientRect();
      showTip(b._tip, r.right, r.top);
    });
    root.addEventListener('focusout', hideTip);
  };

  // ---------- Horizontal bar chart ----------
  // groups: [{ label, sub, bars: [{ engine, value, text, tip, na }] }]
  const niceStep = (raw) => {
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  };
  const barChart = (root, groups) => {
    root.replaceChildren();
    const values = groups.flatMap((g) => g.bars.map((b) => b.value).filter((v) => v != null));
    if (!values.length) return;
    const step = niceStep(Math.max(...values) / 4);
    const top = Math.ceil(Math.max(...values) / step) * step;
    const ticks = [];
    for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
    const pct = (v) => `${(v / top) * 100}%`;

    const axis = el('div', 'bchart__axis');
    axis.setAttribute('aria-hidden', 'true');
    const grid = el('div', 'bchart__grid');
    ticks.forEach((t, i) => {
      const lab = el('span', null, i === ticks.length - 1 ? `${num(t, 0)} ms` : num(t, 0));
      lab.style.left = pct(t);
      if (i === ticks.length - 1) lab.style.transform = 'translateX(-100%)';
      axis.append(lab);
      const line = el('i');
      line.style.left = pct(t);
      grid.append(line);
    });

    const body = el('div', 'bchart__body');
    body.append(grid);
    for (const g of groups) {
      const row = el('div', 'bgroup');
      const label = el('div', 'bgroup__label');
      label.append(el('b', null, g.label), el('span', null, g.sub));
      const bars = el('div', 'bgroup__bars');
      for (const b of g.bars) {
        const bar = el('div', `bbar c-${ENGINE_CLASS[b.engine]}`);
        if (b.value == null) {
          bar.append(el('span', 'bbar__na', b.na));
        } else {
          const fill = el('span', 'bbar__fill');
          fill.style.width = pct(b.value);
          fill.tabIndex = 0;
          fill.setAttribute('role', 'img');
          fill.setAttribute('aria-label', `${g.label}, ${b.engine}: ${b.text}`);
          fill._tip = b.tip;
          const val = el('span', 'bbar__val');
          val.append(el('strong', null, fmtMs(b.value)), document.createTextNode(' ms'));
          bar.append(fill, val);
        }
        bars.append(bar);
      }
      row.append(label, bars);
      body.append(row);
    }
    root.append(axis, body);
  };

  // ---------- Explorer table ----------
  const tbody = $('#rows');

  const memCell = (r) => {
    const td = el('td', 'c-mem num');
    const m = r.mem || {};
    if (m.vram != null) {
      td.append(document.createTextNode(fmtMiB(m.vram)), el('span', 'sub', m.rss != null ? `VRAM + ${fmtMiB(m.rss)} host` : 'VRAM'));
    } else if (m.shared != null) {
      td.append(document.createTextNode(fmtMiB(m.shared)), el('span', 'sub', `shared + ${fmtMiB(m.rss)} RSS`));
    } else if (m.rss != null) {
      td.append(document.createTextNode(fmtMiB(m.rss)), el('span', 'sub', 'peak RSS'));
    } else {
      td.append(document.createTextNode('–'), el('span', 'sub', 'not reported'));
    }
    return td;
  };

  const rowEl = (r) => {
    const tr = el('tr', open.has(r.i) ? 'row is-open' : 'row');
    tr.dataset.i = r.i;

    const tdModel = el('td', 'c-model');
    const btn = el('button', 'expand');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(open.has(r.i)));
    btn.setAttribute('aria-controls', `d-${r.i}`);
    btn.append(el('span', 'chev'), document.createTextNode(r.m.name));
    tdModel.append(btn, engChip(r.engine));

    const tdHw = el('td', 'c-hw');
    const sub = el('span', 'sub', r.hw);
    if (r.earlier) sub.append(el('span', 'tag', 'earlier build'));
    if (r.stat === 'min') sub.append(el('span', 'tag', 'author’s run'));
    tdHw.append(el('span', 'dev', r.d.short), sub);

    const tdSetup = el('td', 'c-setup', r.setup);
    if (r.vsDefaults) tdSetup.append(el('span', 'sub', `${r.vsDefaults.replace('-', '−')} vs defaults`));

    const tdLat = el('td', 'c-lat');
    const cell = el('div', 'latcell');
    const strip = el('span', 'strip');
    strip.setAttribute('aria-hidden', 'true');
    for (const t of [1, 2, 3, 4]) {
      const tick = el('b');
      tick.style.left = `${(t / LOG_MAX) * 100}%`;
      strip.append(tick);
    }
    const dot = el('i');
    dot.style.left = `${Math.min(100, Math.max(0, (Math.log10(r.ms) / LOG_MAX) * 100))}%`;
    dot.style.setProperty('--c', `var(--${ENGINE_CLASS[r.engine]})`);
    strip.append(dot);
    const val = el('span', 'val', fmtMs(r.ms));
    cell.append(strip, val);
    tdLat.append(cell);

    const tdRate = el('td', 'c-rate num', fmtRate(r.rate));

    tr.append(tdModel, tdHw, tdSetup, tdLat, tdRate, memCell(r));
    return tr;
  };

  const kv = (pairs) => {
    const dl = el('dl');
    for (const [k, v] of pairs) {
      if (v == null || v === '') continue;
      dl.append(el('dt', null, k), el('dd', null, v));
    }
    return dl;
  };

  const STAT_LABEL = { min: 'min', mean: 'mean', p50: 'p50', p90: 'p90', p10: 'p10', median: 'median', p95: 'p95' };
  const detailEl = (r) => {
    const tr = el('tr', 'detail');
    tr.id = `d-${r.i}`;
    const td = el('td');
    td.colSpan = 6;
    const grid = el('div', 'detail__grid');
    const eng = META.engines[r.engine];

    const lat = el('div');
    lat.append(el('h4', null, 'Latency'));
    const order = r.engine === 'vla.simd' ? ['p10', 'median', 'p90', 'p95'] : ['min', 'mean', 'p50', 'p90'];
    const pairs = order.filter((k) => r.stats && r.stats[k] != null)
      .map((k) => [`${STAT_LABEL[k]}${k === r.stat ? ' (shown)' : ''}`, `${fmtMs(r.stats[k])} ms`]);
    if (r.vision != null) pairs.push(['vision stage', `${fmtMs(r.vision)} ms`]);
    pairs.push(['actions / s', `${fmtRate(r.rate)} (chunk of ${r.spec.chunk})`]);
    lat.append(kv(pairs), el('p', 'sub', eng.protocol[r.stat]));

    const mem = el('div');
    mem.append(el('h4', null, 'Memory'));
    const m = r.mem || {};
    mem.append(m.vram == null && m.shared == null && m.rss == null
      ? el('p', null, 'Not reported.')
      : kv([
        ['VRAM', m.vram != null ? fmtMiB(m.vram) : null],
        ['device buffers', m.shared != null ? `${fmtMiB(m.shared)} (shared)` : null],
        [m.vram != null ? 'host RSS' : 'peak RSS', m.rss != null ? fmtMiB(m.rss) : null],
      ]));

    const setup = el('div');
    setup.append(el('h4', null, 'Setup'));
    if (r.engine === 'vla.simd') {
      setup.append(kv([
        ['precision', r.config === 'INT8' ? 'INT8 (W8A8)' : 'FP32'],
        ['threads', String(r.threads)],
        ['INT8 layers', r.config === 'INT8' ? r.int8Mask : null],
        ['settings', r.other],
        ['kernels', r.backend],
      ]));
    } else {
      const p = el('p');
      if (r.flags) p.append(el('code', null, r.flags));
      else p.append(document.createTextNode('Default runtime flags.'));
      setup.append(p, kv([['backend', r.hw], ['build', r.build], ['views', r.views != null ? String(r.views) : null]]));
    }

    const ckpt = el('div');
    ckpt.append(el('h4', null, 'Checkpoint'));
    const s = r.spec;
    ckpt.append(kv([
      ['trained on', s.data],
      ['input', `${s.views} × ${s.input}`],
      ['action chunk', `${s.chunk} × ${s.actions}`],
      ['action head', s.head],
      ['language', s.lang],
    ]));
    if (s.hfNote) ckpt.append(el('p', 'sub', s.hfNote));

    grid.append(lat, mem, setup, ckpt);
    td.append(grid);

    const note = r.d.notes && r.d.notes[r.engine];
    if (note) td.append(el('p', 'sub', note));
    const links = el('div', 'detail__links');
    links.append(link(new URL(r.report, eng.reports).href, 'Source report ↗'));
    if (s.hf) links.append(link(`https://huggingface.co/${s.hf}`, `${s.hf} ↗`));
    links.append(link(r.m.href, `${r.m.name} upstream ↗`));
    td.append(links);
    tr.append(td);
    return tr;
  };

  const groupEl = (r) => {
    const tr = el('tr', 'group');
    const th = el('th');
    th.colSpan = 6;
    th.scope = 'rowgroup';
    if (state.sort === 'model') {
      th.append(document.createTextNode(r.m.name), el('span', 'group__meta', r.m.by));
      if (state.model === 'all') {
        const b = el('button', 'linkbtn', 'Model details');
        b.type = 'button';
        b.dataset.model = r.model;
        th.append(b);
      }
    } else {
      th.append(document.createTextNode(r.d.name), el('span', 'group__meta', `${r.d.kind} · ${r.d.memory}`));
    }
    tr.append(th);
    return tr;
  };

  const renderTable = (rows) => {
    const frag = document.createDocumentFragment();
    const grouped = state.sort === 'model' || state.sort === 'device';
    let last = null;
    for (const r of rows.slice(0, limit)) {
      const g = state.sort === 'model' ? r.model : r.device;
      if (grouped && g !== last) { frag.append(groupEl(r)); last = g; }
      frag.append(rowEl(r));
      if (open.has(r.i)) frag.append(detailEl(r));
    }
    tbody.replaceChildren(frag);
    $('#empty').hidden = rows.length > 0;
    const more = $('#more');
    more.hidden = rows.length <= limit;
    more.textContent = `Show all ${num(rows.length, 0)} measurements`;
    const count = $('#count');
    count.replaceChildren(el('strong', null, num(rows.length, 0)),
      document.createTextNode(rows.length === 1 ? ' measurement' : ' measurements'));
    count.append(document.createTextNode(state.all ? ', every configuration' : ', fastest configuration per device and processor'));
    if (rows.length > limit) count.append(document.createTextNode(` · showing ${limit}`));
  };

  // ---------- Model panel ----------
  const panel = $('#model-panel');
  const renderPanel = (rows) => {
    if (state.model === 'all') { panel.hidden = true; panel.replaceChildren(); return; }
    const id = state.model;
    const m = META.models[id];
    panel.replaceChildren();

    const head = el('div', 'mpanel__head');
    const hl = el('div');
    hl.append(el('h3', null, m.name));
    const by = el('p', 'mpanel__by', `${m.by} · `);
    by.append(link(m.href, 'upstream ↗'));
    hl.append(by, el('p', 'mpanel__summary', m.summary));
    const close = el('button', 'btn btn--ghost', 'All models');
    close.type = 'button';
    close.addEventListener('click', () => update({ model: 'all' }));
    head.append(hl, close);
    panel.append(head);

    const specs = el('div', 'mpanel__specs');
    for (const [engine, s] of Object.entries(m.engines)) {
      const card = el('div', 'spec');
      const sh = el('div', 'spec__head');
      sh.append(engChip(engine));
      const own = ROWS.filter((r) => r.model === id && r.engine === engine);
      sh.append(el('span', 'sub', `${new Set(own.map((r) => r.device)).size} devices`));
      card.append(sh, kv([
        ['trained on', s.data],
        ['input', `${s.views} × ${s.input}`],
        ['action chunk', `${s.chunk} × ${s.actions}`],
        ['action head', s.head],
        ['language', s.lang],
      ]));
      if (s.hf) {
        const a = link(`https://huggingface.co/${s.hf}`, `huggingface.co/${s.hf} ↗`, 'spec__hf');
        card.append(a);
      }
      if (s.hfNote) card.append(el('span', 'spec__hf-note', s.hfNote));
      specs.append(card);
    }
    panel.append(specs);

    const lib = BENCH.libero.object[id];
    if (lib) {
      const box = el('div', 'libero');
      const main = el('span');
      main.append(el('strong', null, `${num(lib.rate, 1)}%`), document.createTextNode(` LIBERO-Object (${lib.successes} episodes, vla.cpp)`));
      box.append(main);
      const suites = BENCH.libero.suites[id];
      if (suites) {
        for (const [k, v] of Object.entries(suites)) if (k !== 'Object') box.append(el('span', null, `${k}: ${num(v, 1)}%`));
      }
      const noteText = lib.rate < 80
        ? 'Below the published result for this checkpoint; the vla.cpp report has not investigated it yet.'
        : 'Success belongs to the checkpoint at default flags, measured on an RTX 3090 with 200 episodes per suite.';
      box.append(el('span', 'libero__note', noteText));
      panel.append(box);
    }

    const chartRows = (state.all ? bestPerKey(rows) : rows).slice().sort((a, b) => a.ms - b.ms);
    const wrap = el('div');
    wrap.append(el('p', 'chart-title', `${m.name} on each device`));
    wrap.append(el('p', 'chart-sub', 'Fastest configuration per device and processor, matching the filters above. Lower is better.'));
    const engines = [...new Set(chartRows.map((r) => r.engine))];
    if (engines.length > 1) {
      const lg = el('div', 'legend');
      lg.setAttribute('aria-hidden', 'true');
      for (const e of engines) {
        const s = el('span');
        const k = el('i', `key key--${ENGINE_CLASS[e]}`);
        s.append(k, document.createTextNode(e));
        lg.append(s);
      }
      wrap.append(lg);
    }
    const chart = el('div', 'bchart');
    if (chartRows.length) {
      barChart(chart, chartRows.map((r) => ({
        label: r.d.short,
        sub: `${r.hw} · ${r.engine}`,
        bars: [{
          engine: r.engine, value: r.ms, text: `${fmtMs(r.ms)} ms`,
          tip: {
            value: `${fmtMs(r.ms)} ms`,
            lines: [
              { text: `${r.d.short} · ${r.hw}` },
              { text: r.engine, c: ENGINE_CLASS[r.engine] },
              { text: r.setup },
              { text: `${fmtRate(r.rate)} actions/s` },
            ],
          },
        }],
      })));
    } else {
      chart.append(el('p', 'sub', 'No measurement of this model matches the current filters.'));
    }
    wrap.append(chart);
    panel.append(wrap);
    panel.hidden = false;
  };

  // ---------- Controls ----------
  const modelSel = $('#f-model');
  const deviceSel = $('#f-device');
  modelSel.append(new Option('All models', 'all'), ...MODEL_IDS.map((id) => new Option(META.models[id].name, id)));
  deviceSel.append(new Option('All devices', 'all'));
  const kinds = [];
  for (const id of DEVICE_IDS) if (!kinds.includes(META.devices[id].kind)) kinds.push(META.devices[id].kind);
  for (const k of kinds) {
    const og = document.createElement('optgroup');
    og.label = k;
    for (const id of DEVICE_IDS) if (META.devices[id].kind === k) og.append(new Option(META.devices[id].short, id));
    deviceSel.append(og);
  }

  const syncControls = () => {
    $('#q').value = state.q;
    for (const name of ['engine', 'proc']) {
      $$(`input[name="${name}"]`).forEach((i) => { i.checked = i.value === state[name]; });
    }
    modelSel.value = state.model;
    deviceSel.value = state.device;
    $('#f-sort').value = state.sort;
    $('#f-rt').checked = state.rt;
    $('#f-all').checked = state.all;
  };

  // ---------- Requests and submitted results, as issues on the hub's repo ----------
  const ISSUES = 'https://github.com/khanhnd61-vr/vla-hub/issues/new';
  // filters: the explorer's selection applies too (the hero search ignores it, as submitting it does)
  const issueUrl = (kind, query = state.q, filters = state) => {
    const q = query.trim();
    const named = parseQuery(q).models; // a policy typed by name, e.g. "pi0.5"
    const fromQuery = filters.model === 'all' && named && named.size === 1;
    const modelId = filters.model !== 'all' ? filters.model : fromQuery ? [...named][0] : null;
    const model = modelId ? META.models[modelId].name : '';
    const device = filters.device !== 'all' ? META.devices[filters.device].name : '';
    const engine = filters.engine !== 'all' ? filters.engine : '';
    // The words left once the policy's name is taken out, e.g. "Jetson" in "SmolVLA Jetson"
    const rest = fromQuery ? q.split(/\s+/).filter((w) => !MODEL_ALIAS.has(norm(w))).join(' ') : q;
    let what;
    if (model && device) what = `${model} on ${device}`;
    else if (model) what = `${model} on ${rest || '<device>'}`;
    else if (device) what = `${rest || '<policy>'} on ${device}`;
    else what = q || '<policy> on <device>';
    if (engine) what += ` with ${engine}`;
    // The issue forms in .github/ISSUE_TEMPLATE carry the measuring guide; a query
    // parameter named after a field's id fills that field in.
    const params = {
      template: kind === 'request' ? 'benchmark-request.yml' : 'benchmark-result.yml',
      title: `${kind === 'request' ? 'Benchmark request' : 'Benchmark result'}: ${what}`,
    };
    const spec = modelId && engine ? META.models[modelId].engines[engine] : null;
    if (model) params.policy = kind !== 'request' && spec && spec.hf ? `${model} (${spec.hf})` : model;
    if (device) params.device = device;
    if (engine) params.engine = engine;
    return `${ISSUES}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  };

  // The hero's buttons follow what is typed in the hero search, the others the explorer.
  const heroQ = $('#hero-q');
  const syncIssues = () => {
    $$('[data-issue]').forEach((a) => {
      a.href = a.closest('.hero') && heroQ.value.trim()
        ? issueUrl(a.dataset.issue, heroQ.value, DEFAULTS)
        : issueUrl(a.dataset.issue);
    });
  };
  heroQ.addEventListener('input', syncIssues);

  const render = () => {
    const rows = filtered();
    renderTable(rows);
    renderPanel(rows);
    syncIssues();
    writeURL();
  };
  const update = (patch, { keepPage = false } = {}) => {
    state = { ...state, ...patch };
    if (!keepPage) limit = PAGE;
    syncControls();
    render();
  };

  let qTimer = 0;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    const v = e.target.value;
    qTimer = setTimeout(() => { state.q = v; limit = PAGE; render(); }, 90);
  });
  $$('input[name="engine"], input[name="proc"]').forEach((i) =>
    i.addEventListener('change', () => update({ [i.name]: i.value })));
  modelSel.addEventListener('change', () => update({ model: modelSel.value }));
  deviceSel.addEventListener('change', () => update({ device: deviceSel.value }));
  $('#f-sort').addEventListener('change', (e) => update({ sort: e.target.value }));
  $('#f-rt').addEventListener('change', (e) => update({ rt: e.target.checked }));
  $('#f-all').addEventListener('change', (e) => update({ all: e.target.checked }));
  const reset = () => { open.clear(); update({ ...DEFAULTS }); };
  $('#reset').addEventListener('click', reset);
  $$('[data-reset]').forEach((b) => b.addEventListener('click', reset));
  $('#more').addEventListener('click', () => { limit = Infinity; render(); });

  tbody.addEventListener('click', (e) => {
    const pickModel = e.target.closest('[data-model]');
    if (pickModel) { update({ model: pickModel.dataset.model }); return; }
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr.row');
    if (!tr) return;
    const i = Number(tr.dataset.i);
    const r = ROWS[i];
    const btn = $('.expand', tr);
    if (open.has(i)) {
      open.delete(i);
      tr.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      const d = document.getElementById(`d-${i}`);
      if (d) d.remove();
    } else {
      open.add(i);
      tr.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      tr.after(detailEl(r));
    }
  });

  // Search from the hero, or a suggestion, then land on the explorer.
  const goSearch = (q) => {
    update({ q, model: 'all', device: 'all' });
    $('#explorer').scrollIntoView();
    $('#q').focus({ preventScroll: true });
  };
  $('[data-hero-search]').addEventListener('submit', (e) => { e.preventDefault(); goSearch($('#hero-q').value.trim()); });
  $$('.suggest [data-q]').forEach((b) => b.addEventListener('click', () => goSearch(b.dataset.q)));
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    (window.scrollY < 300 ? $('#hero-q') : $('#q')).focus();
  });

  // ---------- Counts ----------
  const count = (fn, rows = ROWS) => new Set(rows.map(fn)).size;
  const COUNTS = {
    models: count((r) => r.model),
    devices: count((r) => r.device),
    targets: count((r) => `${r.device}|${r.unit}|${r.backend}`),
    results: ROWS.length,
  };
  $$('[data-count]').forEach((n) => { n.textContent = num(COUNTS[n.dataset.count], 0); });
  $$('[data-round]').forEach((n) => { n.textContent = BENCH.rounds[n.dataset.round]; });
  $$('[data-generated]').forEach((n) => { n.textContent = BENCH.generated; });

  // ---------- Engines ----------
  const renderEngines = () => {
    const root = $('#engine-cards');
    for (const [id, e] of Object.entries(META.engines)) {
      const rows = ROWS.filter((r) => r.engine === id);
      const card = el('article', `engine c-${ENGINE_CLASS[id]}`);
      const thumb = el('div', 'engine__thumb');
      thumb.append(el('h3', 'engine__name', e.name));
      const body = el('div', 'engine__body');
      const nums = el('div', 'engine__nums');
      for (const [n, label] of [
        [count((r) => r.model, rows), 'policies'],
        [count((r) => r.device, rows), 'devices'],
        [count((r) => `${r.device}|${r.unit}|${r.backend}`, rows), 'hardware targets'],
      ]) {
        const d = el('div');
        d.append(el('strong', null, String(n)), el('span', null, label));
        nums.append(d);
      }
      const facts = kv(e.facts);
      const links = el('div', 'engine__links');
      for (const l of e.links) {
        const a = link(l.href, l.label, l.hf ? 'pill pill--hf' : 'pill');
        a.append(document.createTextNode(' ↗'));
        links.append(a);
      }
      body.append(el('p', 'engine__tag', e.tagline), el('p', 'engine__blurb', e.blurb), nums, facts, links);
      card.append(thumb, body);
      root.append(card);
    }
  };

  const HW_CLASSES = [
    { label: 'NVIDIA GPUs', test: (r) => r.backend === 'CUDA' && r.d.kind !== 'Embedded' },
    { label: 'NVIDIA Jetson', test: (r) => r.d.kind === 'Embedded' },
    { label: 'Apple Silicon GPUs', test: (r) => r.backend === 'Metal' },
    { label: 'Intel GPUs', test: (r) => r.proc === 'GPU' && (r.backend === 'SYCL' || r.backend === 'OpenVINO') },
    { label: 'NPUs', test: (r) => r.proc === 'NPU' },
    { label: 'x86 CPUs', test: (r) => r.proc === 'CPU' && ['i5', 'i7', 'i9', 'ryzen5', 'x7'].includes(r.device) },
    { label: 'Arm CPUs', test: (r) => r.proc === 'CPU' && ['m4', 'snapx', 'pi5'].includes(r.device) },
  ];
  const renderCoverage = () => {
    const table = $('#coverage');
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', null, 'Hardware'));
    for (const e of ENGINES) { const th = el('th'); th.append(engChip(e)); hr.append(th); }
    thead.append(hr);
    const tb = el('tbody');
    const total = Object.fromEntries(ENGINES.map((e) => [e, count((r) => r.model, ROWS.filter((r) => r.engine === e))]));
    for (const c of HW_CLASSES) {
      const rows = ROWS.filter(c.test);
      const tr = el('tr');
      const th = el('th');
      th.scope = 'row';
      const hwName = (r) => {
        if (r.unit === 'NPU') return `${r.d.short} ${r.backend}`;
        return r.unit === 'GPU' || r.unit.endsWith('CPU') ? r.d.short : r.unit;
      };
      const names = [...new Set(rows.sort((a, b) => DEVICE_RANK[a.device] - DEVICE_RANK[b.device]).map(hwName))];
      th.append(document.createTextNode(c.label), el('small', null, names.join(', ')));
      tr.append(th);
      for (const e of ENGINES) {
        const td = el('td');
        const n = count((r) => r.model, rows.filter((r) => r.engine === e));
        if (n) {
          const wrap = el('span', `cov c-${ENGINE_CLASS[e]}`);
          const bar = el('span', 'cov__bar');
          const fill = el('i');
          fill.style.width = `${(n / total[e]) * 100}%`;
          bar.append(fill);
          wrap.append(bar, document.createTextNode(`${n} of ${total[e]} models`));
          td.append(wrap);
        } else {
          td.append(el('span', 'cov__none', '—'), el('span', 'sr', 'not measured'));
        }
        tr.append(td);
      }
      tb.append(tr);
    }
    table.append(thead, tb);
  };

  // ---------- Compare ----------
  const CMP_MODELS = MODEL_IDS.filter((id) => ENGINES.every((e) => META.models[id].engines[e]));
  const cmp = { model: CMP_MODELS[0], prec: 'FP32' };
  const renderCompare = () => {
    const id = cmp.model;
    const m = META.models[id];
    const hasInt8 = ROWS.some((r) => r.model === id && r.config === 'INT8');
    const int8 = $('input[name="cmp-prec"][value="INT8"]');
    int8.disabled = !hasInt8;
    if (!hasInt8 && cmp.prec === 'INT8') {
      cmp.prec = 'FP32';
      $('input[name="cmp-prec"][value="FP32"]').checked = true;
    }
    $('#compare-simd-label').textContent = `vla.simd, ${cmp.prec === 'INT8' ? 'INT8 (W8A8)' : 'FP32'}`;
    $$('#compare-models button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.model === id)));

    const devices = DEVICE_IDS.filter((d) =>
      ROWS.some((r) => r.engine === 'vla.simd' && r.device === d && r.model === id) &&
      ROWS.some((r) => r.engine === 'vla.cpp' && r.device === d && r.proc === 'CPU' && r.model === id));
    const groups = devices.map((d) => {
      const cpp = ROWS.filter((r) => r.engine === 'vla.cpp' && r.device === d && r.proc === 'CPU' && r.model === id)
        .reduce((a, b) => (b.ms < a.ms ? b : a));
      const simd = ROWS.find((r) => r.engine === 'vla.simd' && r.device === d && r.model === id && r.config === cmp.prec);
      const bar = (r) => ({
        engine: r.engine, value: r.ms, text: `${fmtMs(r.ms)} ms`,
        tip: {
          value: `${fmtMs(r.ms)} ms`,
          lines: [
            { text: `${r.d.short} · ${r.hw}` },
            { text: r.engine, c: ENGINE_CLASS[r.engine] },
            { text: r.setup },
            { text: `${fmtRate(r.rate)} actions/s` },
          ],
        },
      });
      return {
        device: d, cpp, simd,
        label: META.devices[d].short,
        sub: META.devices[d].kind,
        bars: [bar(cpp), simd ? bar(simd) : { engine: 'vla.simd', value: null, na: `no ${cmp.prec} path on this CPU` }],
      };
    }).sort((a, b) => (a.simd ? a.simd.ms : Infinity) - (b.simd ? b.simd.ms : Infinity) || a.cpp.ms - b.cpp.ms);

    const pairs = groups.filter((g) => g.simd);
    const summary = $('#compare-summary');
    if (!pairs.length) {
      summary.textContent = `${m.name} has no ${cmp.prec} measurement in vla.simd on these CPUs.`;
    } else {
      const ratios = pairs.map((g) => g.cpp.ms / g.simd.ms).sort((a, b) => a - b);
      const median = ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
      const simdWins = pairs.filter((g) => g.simd.ms < g.cpp.ms);
      const cppWins = pairs.filter((g) => g.cpp.ms <= g.simd.ms).map((g) => g.label);
      let text = `On ${m.name}, vla.simd ${cmp.prec === 'INT8' ? 'INT8' : 'FP32'} is faster on ${simdWins.length} of ${pairs.length} CPUs`;
      text += median >= 1 ? `, by a median ${num(median, 1)}×.` : `; the median ratio is ${num(median, 2)}×.`;
      if (cppWins.length) text += ` vla.cpp is faster on the ${cppWins.join(' and ')}.`;
      if (!hasInt8) text += ` ${m.name} has no INT8 path in vla.simd.`;
      summary.textContent = text;
    }
    barChart($('#compare-chart'), groups);
  };
  const renderCompareTabs = () => {
    const tabs = $('#compare-models');
    for (const id of CMP_MODELS) {
      const b = el('button', null, META.models[id].name);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.model = id;
      b.addEventListener('click', () => { cmp.model = id; renderCompare(); });
      tabs.append(b);
    }
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = CMP_MODELS.indexOf(cmp.model) + (e.key === 'ArrowRight' ? 1 : -1);
      cmp.model = CMP_MODELS[(i + CMP_MODELS.length) % CMP_MODELS.length];
      renderCompare();
      $(`#compare-models [data-model="${cmp.model}"]`).focus();
    });
    $$('input[name="cmp-prec"]').forEach((i) => i.addEventListener('change', () => { cmp.prec = i.value; renderCompare(); }));
  };

  // ---------- Model cards ----------
  const renderModels = () => {
    const grid = $('#model-grid');
    for (const id of MODEL_IDS) {
      const m = META.models[id];
      const rows = ROWS.filter((r) => r.model === id);
      if (!rows.length) continue;
      const card = el('article', 'mcard');
      const head = el('div', 'mcard__head');
      head.append(el('h3', null, m.name), el('span', 'mcard__by', m.by));
      const engines = el('div', 'mcard__engines');
      for (const e of Object.keys(m.engines)) engines.append(engChip(e));

      const fastest = rows.reduce((a, b) => (b.ms < a.ms ? b : a));
      const cpuRows = rows.filter((r) => r.proc === 'CPU');
      const cpu = cpuRows.length ? cpuRows.reduce((a, b) => (b.ms < a.ms ? b : a)) : null;
      const where = (r) => `${fmtMs(r.ms)} ms · ${r.d.short}, ${r.engine}`;
      const lib = BENCH.libero.object[id];
      const facts = kv([
        ['Fastest', where(fastest)],
        ['Fastest CPU', cpu && cpu !== fastest ? where(cpu) : null],
        ['Devices', `${count((r) => r.device, rows)} measured`],
        ['LIBERO-Object', lib ? `${num(lib.rate, 1)}% success` : null],
      ]);
      facts.className = 'mcard__facts';

      const foot = el('div', 'mcard__foot');
      const go = el('button', 'btn', 'See every device');
      go.type = 'button';
      go.addEventListener('click', () => {
        open.clear();
        update({ ...DEFAULTS, model: id, sort: 'latency' });
        $('#explorer').scrollIntoView();
      });
      foot.append(go);
      for (const [e, s] of Object.entries(m.engines)) {
        if (s.hf) foot.append(link(`https://huggingface.co/${s.hf}`, `${e} GGUF ↗`));
      }
      card.append(head, el('p', 'mcard__summary', m.summary), engines, facts, foot);
      grid.append(card);
    }
  };

  // ---------- Start ----------
  bindTips($('#explorer'));
  bindTips($('#compare-chart'));
  renderEngines();
  renderCoverage();
  renderCompareTabs();
  renderCompare();
  renderModels();
  state = readURL();
  syncControls();
  render();
})();
