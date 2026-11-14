// 需求波动向上游传递观察台 —— 页面逻辑。
// 数据：data/dataset.js（管线生成，观察值）；指标：metrics.js（与测试共用）。
import { ratioMetric, REASON_LABELS, MIN_PERIODS, MEAN_EPS } from './metrics.js';

const DATA = window.DATASET;
const META = DATA.meta;
const N_WEEKS = META.weeks.length;

const SERIES_DEFS = [
  { key: 'demand',      name: '门店销量(需求)', color: '--s1' },
  { key: 'storeOrders', name: '门店订货',      color: '--s2' },
  { key: 'dcOrders',    name: 'DC 订货',       color: '--s3' },
  { key: 'supplier',    name: '供应商交付',     color: '--s4' },
];
const PAIRS = [
  { key: 'L2/L1', name: '门店订货 / 门店需求', down: 'demand',      up: 'storeOrders' },
  { key: 'L3/L2', name: 'DC 订货 / 门店订货',  down: 'storeOrders', up: 'dcOrders' },
  { key: 'L4/L3', name: '供应商交付 / DC 订货', down: 'dcOrders',   up: 'supplier' },
];
const RANGES = {
  all:     Array.from({ length: N_WEEKS }, (_, i) => i),
  first13: Array.from({ length: 13 }, (_, i) => i),
  last13:  Array.from({ length: 13 }, (_, i) => 13 + i),
  recent8: Array.from({ length: 8 }, (_, i) => N_WEEKS - 8 + i),
};
const state = { sku: META.products[0].id, scope: 'ALL', metric: 'var', range: 'all', R: 2, L: 2 };

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('zh-CN');
const cssVar = (n) => getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(n).trim();
const pick = (arr, idx) => idx.map((i) => arr[i]);

// ---------- 初始化 ----------
function init() {
  const skuSel = $('f-sku');
  for (const p of META.products) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.name}（${p.id}，箱规 ${p.pack}）`;
    skuSel.appendChild(o);
  }
  const scopeSel = $('f-scope');
  const scopes = [
    ['ALL', '全网络（6 店 / 2 DC）'],
    ...META.dcs.map((d) => [d.id, `配送中心 ${d.id}（${d.stores.length} 店）`]),
    ...META.stores.map((s) => [s.id, `门店 ${s.id}（属 ${s.dc}）`]),
  ];
  for (const [v, label] of scopes) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    scopeSel.appendChild(o);
  }
  scopeSel.value = 'ALL';
  skuSel.addEventListener('change', () => { state.sku = skuSel.value; render(); });
  scopeSel.addEventListener('change', () => { state.scope = scopeSel.value; render(); });
  $('f-metric').addEventListener('change', (e) => { state.metric = e.target.value; render(); });
  $('f-range').addEventListener('change', (e) => { state.range = e.target.value; render(); });
  $('f-R').addEventListener('change', (e) => { state.R = +e.target.value; render(); });
  $('f-L').addEventListener('change', (e) => { state.L = +e.target.value; render(); });
  document.querySelectorAll('.table-toggle').forEach((b) =>
    b.addEventListener('click', () => toggleTable(b.dataset.target)));
  $('modal-close').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', (e) => { if (e.target === $('modal-backdrop')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  $('theme-toggle').addEventListener('click', toggleTheme);
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    $('theme-toggle').textContent = '浅色模式';
  }
  render();
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme !== 'dark';
  root.dataset.theme = dark ? 'dark' : 'light';
  $('theme-toggle').textContent = dark ? '浅色模式' : '深色模式';
  render();
}

// ---------- 数据解析 ----------
function resolveCtx() {
  const w = DATA.weekly[state.sku];
  const kind = state.scope === 'ALL' ? 'network' : state.scope.startsWith('DC') ? 'dc' : 'store';
  const node = kind === 'network' ? w.network : kind === 'dc' ? w.dc[state.scope] : w.store[state.scope];
  const idx = RANGES[state.range];
  const flows = {
    demand: kind === 'store' ? node.sales : node.storeSales,
    storeOrders: kind === 'store' ? node.orders : node.storeOrders,
    dcOrders: kind === 'store' ? null : node.dcOrders,
    supplier: kind === 'store' ? null : node.dcDeliveries,
  };
  return { kind, node, idx, flows };
}

function metricFor(down, up, idx, censored) {
  return ratioMetric(pick(down, idx), pick(up, idx), {
    kind: state.metric, exclude: pick(censored, idx),
  });
}

// ---------- 渲染总入口 ----------
function render() {
  const ctx = resolveCtx();
  renderKpis(ctx);
  renderMainChart(ctx);
  renderEchelons(ctx);
  renderScenario(ctx);
}

// ---------- KPI 行 ----------
function renderKpis(ctx) {
  const { kind, node, idx, flows } = ctx;
  const row = $('kpi-row');
  row.textContent = '';
  const demand = pick(flows.demand, idx);
  const cens = pick(node.censored, idx);
  const minor = pick(node.minorStockout, idx);

  row.appendChild(tile('门店周均销量', fmt.format(Math.round(demand.reduce((a, b) => a + b, 0) / idx.length)) + ' 件',
    `${idx.length} 周 · 需求以销量代理`));
  const nCens = cens.filter(Boolean).length;
  row.appendChild(tile('缺货截断周', `${nCens} 周`,
    `轻微缺货 ${minor.filter(Boolean).length} 周 · 指标中已剔除截断周`));
  row.appendChild(tile('退货合计（单独列示）', fmt.format(pick(node.returns, idx).reduce((a, b) => a + b, 0)) + ' 件',
    '不冲减需求与订货'));

  for (const p of PAIRS) {
    if (kind === 'store' && p.up !== 'storeOrders') continue;
    const m = metricFor(flows[p.down], flows[p.up], idx, node.censored);
    row.appendChild(metricTile(p, m));
  }
}

function tile(label, value, sub) {
  const d = document.createElement('div');
  d.className = 'tile';
  const l = document.createElement('div'); l.className = 't-label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 't-value'; v.textContent = value;
  const s = document.createElement('div'); s.className = 't-sub'; s.textContent = sub;
  d.append(l, v, s);
  return d;
}

function metricTile(pair, m) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile metric';
  const l = document.createElement('div'); l.className = 't-label';
  l.textContent = `${pair.name} · ${state.metric === 'var' ? '方差比' : 'CV² 比'}`;
  const v = document.createElement('div');
  if (m.status === 'ok') {
    v.className = 't-value';
    v.textContent = m.value.toFixed(2) + '×';
  } else {
    v.className = 't-value nc';
    v.textContent = '不可比较';
    const r = document.createElement('div'); r.className = 't-reason';
    r.textContent = REASON_LABELS[m.reason];
    b.append(l, v, r);
  }
  if (m.status === 'ok') b.append(l, v);
  const h = document.createElement('div'); h.className = 't-hint';
  h.textContent = `可比 ${m.n}/${MIN_PERIODS}+ 周 · 点击查看周期数据`;
  b.appendChild(h);
  b.addEventListener('click', () => openDrilldown(pair));
  return b;
}

// ---------- 主图 ----------
function renderMainChart(ctx) {
  const { kind, node, idx, flows } = ctx;
  const keys = kind === 'store' ? ['demand', 'storeOrders'] : ['demand', 'storeOrders', 'dcOrders', 'supplier'];
  const series = keys.map((k) => {
    const def = SERIES_DEFS.find((d) => d.key === k);
    return { name: def.name, color: cssVar(def.color), values: pick(flows[k], idx) };
  });
  $('main-sub').textContent =
    `单位：件/周（箱已按箱规换算）· ${META.weeks[idx[0]].label}–${META.weeks[idx[idx.length - 1]].label}` +
    (kind === 'store' ? ' · 单店范围不含 DC 与供应商层' : '');

  const bands = [];
  idx.forEach((w, j) => { if (node.censored[w]) bands.push({ x: j, color: cssVar('--critical'), label: '缺货截断周' }); });
  const markers = [];
  idx.forEach((w, j) => {
    if (node.promo[w]) markers.push({ x: j, type: 'promo', color: cssVar('--s5'), label: '促销周' });
  });
  if (kind !== 'store' && node.delayedWeeks) {
    const delayed = new Set(node.delayedWeeks);
    idx.forEach((w, j) => { if (delayed.has(w)) markers.push({ x: j, type: 'delay', color: cssVar('--serious'), label: '延迟到货周', series: '供应商交付' }); });
  }

  const wrap = $('chart-main');
  drawLineChart(wrap, {
    series, bands, markers,
    weekIdx: idx,
    flagsFor: (j) => weekFlags(node, idx[j]),
    legendExtra: [
      { kind: 'band', color: cssVar('--critical'), label: '缺货截断周（指标中剔除）' },
      { kind: 'tri', color: cssVar('--s5'), label: '促销周' },
      ...(kind !== 'store' ? [{ kind: 'dia', color: cssVar('--serious'), label: '延迟到货周' }] : []),
    ],
  });
  buildTable($('table-main'), idx, series, (j) => weekFlags(node, idx[j]));
}

function weekFlags(node, w) {
  const f = [];
  if (node.censored[w]) f.push({ text: `缺货截断（损失 ${fmt.format(node.lost[w])} 件，指标中剔除）`, crit: true });
  else if (node.minorStockout[w]) f.push({ text: `轻微缺货（损失 ${fmt.format(node.lost[w])} 件）`, crit: false });
  if (node.promo[w]) f.push({ text: '促销周', crit: false });
  if (node.returns[w] > 0) f.push({ text: `退货 ${fmt.format(node.returns[w])} 件（单独列示）`, crit: false });
  return f;
}

// ---------- 通用折线图 ----------
function drawLineChart(wrap, cfg) {
  wrap.textContent = '';
  const W = Math.max(320, wrap.clientWidth || 800);
  const H = 240, padL = 52, padR = 140, padT = 10, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = cfg.weekIdx.length;
  const x = (j) => padL + (n === 1 ? plotW / 2 : (j / (n - 1)) * plotW);
  const maxV = Math.max(1, ...cfg.series.flatMap((s) => s.values));
  const [yMax, yTicks] = niceScale(maxV);
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  // 图例（HTML，>=2 条序列必须有）
  const legend = document.createElement('div');
  legend.className = 'legend';
  for (const s of cfg.series) {
    const item = document.createElement('span'); item.className = 'item';
    const key = document.createElement('span'); key.className = 'key-line' + (s.dashed ? ' dashed' : '');
    key.style.borderColor = s.color;
    const t = document.createElement('span'); t.textContent = s.name;
    item.append(key, t); legend.appendChild(item);
  }
  for (const ex of cfg.legendExtra || []) {
    const item = document.createElement('span'); item.className = 'item';
    let key;
    if (ex.kind === 'band') { key = document.createElement('span'); key.className = 'key-band'; key.style.background = ex.color; key.style.opacity = '0.25'; }
    else if (ex.kind === 'tri') { key = document.createElement('span'); key.className = 'key-tri'; key.style.borderBottom = `8px solid ${ex.color}`; }
    else { key = document.createElement('span'); key.className = 'key-dia'; key.style.background = ex.color; }
    const t = document.createElement('span'); t.textContent = ex.label;
    item.append(key, t); legend.appendChild(item);
  }
  wrap.appendChild(legend);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '周度流量折线图' });
  // 网格与坐标轴（实线发丝线）
  for (const t of yTicks) {
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t), stroke: cssVar('--gridline'), 'stroke-width': 1 }));
    const lab = svgEl('text', { x: padL - 6, y: y(t) + 3, 'text-anchor': 'end', 'font-size': 10, fill: cssVar('--text-muted') });
    lab.textContent = fmt.format(t);
    svg.appendChild(lab);
  }
  svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y(0), y2: y(0), stroke: cssVar('--baseline'), 'stroke-width': 1 }));
  // 缺货截断周底纹
  for (const b of cfg.bands || []) {
    const bw = n === 1 ? plotW : plotW / (n - 1);
    svg.appendChild(svgEl('rect', {
      x: x(b.x) - bw / 2, y: padT, width: bw, height: plotH,
      fill: b.color, opacity: 0.12,
    }));
  }
  // X 轴刻度（隔一个标注）
  cfg.weekIdx.forEach((w, j) => {
    if (j % 2 === 0 || j === n - 1) {
      const lab = svgEl('text', { x: x(j), y: H - 8, 'text-anchor': 'middle', 'font-size': 10, fill: cssVar('--text-muted') });
      lab.textContent = META.weeks[w].label;
      svg.appendChild(lab);
    }
  });
  // 序列线
  for (const s of cfg.series) {
    const d = s.values.map((v, j) => `${j ? 'L' : 'M'}${x(j).toFixed(1)},${y(v).toFixed(1)}`).join('');
    svg.appendChild(svgEl('path', {
      d, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      ...(s.dashed ? { 'stroke-dasharray': '6 4' } : {}),
    }));
  }
  // 促销/延迟标记
  for (const m of cfg.markers || []) {
    if (m.type === 'promo') {
      svg.appendChild(svgEl('path', {
        d: `M${x(m.x) - 5},${y(0) - 2} L${x(m.x)},${y(0) - 11} L${x(m.x) + 5},${y(0) - 2} Z`,
        fill: m.color,
      }));
    } else if (m.type === 'delay' && m.series) {
      const si = cfg.series.findIndex((s) => s.name === m.series);
      if (si >= 0) {
        const v = cfg.series[si].values[m.x];
        const cy = y(v);
        svg.appendChild(svgEl('rect', {
          x: x(m.x) - 4, y: cy - 4, width: 8, height: 8, fill: m.color,
          transform: `rotate(45 ${x(m.x)} ${cy})`, stroke: cssVar('--surface-1'), 'stroke-width': 2,
        }));
      }
    }
  }
  // 端点直接标注（碰撞时用引导线）
  const ends = cfg.series.map((s, i) => ({ i, y: y(s.values[n - 1]), name: s.name, v: s.values[n - 1], color: s.color }))
    .sort((a, b) => a.y - b.y);
  const MIN_GAP = 14;
  for (let k = 1; k < ends.length; k++) {
    if (ends[k].y - ends[k - 1].y < MIN_GAP) ends[k].y = ends[k - 1].y + MIN_GAP;
  }
  for (const e of ends) {
    const origY = y(cfg.series[e.i].values[n - 1]);
    svg.appendChild(svgEl('circle', { cx: x(n - 1), cy: origY, r: 4, fill: e.color, stroke: cssVar('--surface-1'), 'stroke-width': 2 }));
    if (Math.abs(e.y - origY) > 4) {
      svg.appendChild(svgEl('line', { x1: x(n - 1) + 5, y1: origY, x2: W - padR + 4, y2: e.y, stroke: cssVar('--baseline'), 'stroke-width': 1 }));
    }
    const lab = svgEl('text', { x: W - padR + 8, y: e.y + 3, 'font-size': 10.5, fill: cssVar('--text-secondary') });
    lab.textContent = `${e.name} ${fmt.format(e.v)}`;
    svg.appendChild(lab);
  }
  // 十字线 + 提示框
  const cross = svgEl('line', { y1: padT, y2: padT + plotH, stroke: cssVar('--baseline'), 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  const hit = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  hit.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const j = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / plotW) * (n - 1))));
    cross.setAttribute('x1', x(j)); cross.setAttribute('x2', x(j));
    cross.setAttribute('visibility', 'visible');
    showTooltip(ev.clientX, ev.clientY, cfg.weekIdx[j], cfg.series.map((s) => ({ name: s.name, color: s.color, dashed: s.dashed, value: s.values[j] })), cfg.flagsFor ? cfg.flagsFor(j) : []);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTooltip(); });
  svg.appendChild(hit);
  wrap.appendChild(svg);
}

function niceScale(maxV) {
  const raw = maxV / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = mag;
  for (const m of [1, 2, 2.5, 5, 10]) { if (raw <= m * mag) { step = m * mag; break; } }
  const yMax = Math.ceil(maxV / step) * step;
  const ticks = [];
  for (let v = 0; v <= yMax + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return [yMax, ticks];
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ---------- 提示框 ----------
function showTooltip(cx, cy, weekI, rows, flags) {
  const tt = $('tooltip');
  tt.textContent = '';
  const title = document.createElement('div');
  title.className = 'tt-title';
  title.textContent = `${META.weeks[weekI].label}（${META.weeks[weekI].start} 起）`;
  tt.appendChild(title);
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 'tt-row';
    const key = document.createElement('span'); key.className = 'tt-key' + (r.dashed ? ' dashed' : '');
    key.style.borderColor = r.color;
    const name = document.createElement('span'); name.className = 'tt-name'; name.textContent = r.name;
    const val = document.createElement('span'); val.className = 'tt-val'; val.textContent = fmt.format(r.value);
    row.append(key, name, val);
    tt.appendChild(row);
  }
  for (const f of flags) {
    const d = document.createElement('div');
    d.className = 'tt-flag' + (f.crit ? '' : ' warn');
    d.textContent = f.text;
    tt.appendChild(d);
  }
  tt.classList.remove('hidden');
  const pad = 12;
  const w = tt.offsetWidth, h = tt.offsetHeight;
  tt.style.left = Math.min(window.innerWidth - w - pad, cx + pad) + 'px';
  tt.style.top = Math.min(window.innerHeight - h - pad, cy + pad) + 'px';
}
function hideTooltip() { $('tooltip').classList.add('hidden'); }

// ---------- 表格视图 ----------
function buildTable(wrap, idx, series, flagsFor) {
  wrap.textContent = '';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  const th0 = document.createElement('th'); th0.textContent = '周';
  tr.appendChild(th0);
  for (const s of series) { const th = document.createElement('th'); th.textContent = s.name; tr.appendChild(th); }
  const thf = document.createElement('th'); thf.textContent = '标记';
  tr.appendChild(thf);
  thead.appendChild(tr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  idx.forEach((w, j) => {
    const r = document.createElement('tr');
    const c0 = document.createElement('td'); c0.textContent = `${META.weeks[w].label} ${META.weeks[w].start}`;
    r.appendChild(c0);
    for (const s of series) {
      const c = document.createElement('td'); c.textContent = fmt.format(s.values[j]);
      r.appendChild(c);
    }
    const cf = document.createElement('td');
    const flags = flagsFor(j);
    cf.textContent = flags.map((f) => f.text).join('；');
    if (flags.some((f) => f.crit)) cf.className = 'flag crit';
    else if (flags.length) cf.className = 'flag';
    r.appendChild(cf);
    tbody.appendChild(r);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

function toggleTable(which) {
  const t = $(`table-${which}`), c = $(`chart-${which}`);
  const btn = document.querySelector(`.table-toggle[data-target="${which}"]`);
  const showTable = t.classList.contains('hidden');
  t.classList.toggle('hidden', !showTable);
  if (c) c.classList.toggle('hidden', showTable);
  btn.textContent = showTable ? '图表视图' : '表格视图';
}

// ---------- 分层卡片 ----------
function renderEchelons(ctx) {
  const { kind, node, idx, flows } = ctx;
  const grid = $('echelon-grid');
  grid.textContent = '';
  const gray = cssVar('--context');

  // 门店层
  const storeInv = kind === 'store' ? node.inventory : null;
  const sStats = [
    `<b>${fmt.format(Math.round(pick(flows.demand, idx).reduce((a, b) => a + b, 0) / idx.length))}</b> 件/周 销量`,
    `<b>${pick(node.censored, idx).filter(Boolean).length}</b> 周缺货截断`,
    `<b>${fmt.format(pick(node.returns, idx).reduce((a, b) => a + b, 0))}</b> 件退货（单独列示）`,
  ];
  grid.appendChild(echelonCard('门店层', '销量与周末库存（件）',
    [{ name: '门店销量', color: cssVar('--s1'), values: pick(flows.demand, idx) },
     ...(storeInv ? [{ name: '周末库存', color: gray, values: pick(storeInv, idx) }] : [])],
    ctx, sStats, kind === 'store' ? '门店库存随订货周期波动；缺货截断周见主图底纹。' : '门店合计视图；单店明细可切换网络范围。'));

  if (kind === 'store') {
    const note = document.createElement('div');
    note.className = 'card';
    const h = document.createElement('h2'); h.textContent = '上游层级';
    const p = document.createElement('p'); p.className = 'card-sub';
    p.textContent = '单店范围不包含 DC 订货与供应商交付（DC 订货面向全部下属门店，无法归属到单店）。切换到 DC 或全网络范围查看。';
    note.append(h, p);
    grid.appendChild(note);
    return;
  }

  // DC 层
  const dStats = [
    `<b>${fmt.format(Math.round(pick(flows.dcOrders, idx).reduce((a, b) => a + b, 0) / idx.length))}</b> 件/周 订货`,
    `期末积压 <b>${fmt.format(node.backlog[idx[idx.length - 1]])}</b> 件`,
    `延迟到货 <b>${node.delayedWeeks.filter((w) => idx.includes(w)).length}</b> 单`,
  ];
  grid.appendChild(echelonCard('配送中心层', 'DC 订货、周末库存与积压（件）',
    [{ name: 'DC 订货', color: cssVar('--s3'), values: pick(flows.dcOrders, idx) },
     { name: '周末库存', color: gray, values: pick(node.inventory, idx) },
     { name: '门店订单积压', color: cssVar('--s6'), values: pick(node.backlog, idx) }],
    ctx, dStats, '批量订货（MOQ/整批）使 DC 订货呈块状；积压为未及时履约的门店订单。'));

  // 供应商层
  const supStats = [
    `实际交付 <b>${fmt.format(pick(flows.supplier, idx).reduce((a, b) => a + b, 0))}</b> 件`,
    `延迟到货 <b>${node.delayedWeeks.filter((w) => idx.includes(w)).length}</b> 单（各延迟 1 周）`,
  ];
  grid.appendChild(echelonCard('供应商层', '按承诺日与实际到货日对比（件）',
    [{ name: '实际交付', color: cssVar('--s4'), values: pick(flows.supplier, idx) },
     { name: '承诺交付（按计划日）', color: gray, dashed: true, values: pick(node.dcDeliveriesPromised, idx) }],
    ctx, supStats, '交付是履约结果而非订货决策；其波动比反映履约平滑程度。'));
}

function echelonCard(title, sub, series, ctx, statHtml, noteText) {
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  const hd = document.createElement('div');
  const h = document.createElement('h2'); h.textContent = title;
  const p = document.createElement('p'); p.className = 'card-sub'; p.textContent = sub;
  hd.append(h, p);
  const btn = document.createElement('button');
  btn.className = 'btn-ghost'; btn.type = 'button'; btn.textContent = '表格视图';
  head.append(hd, btn);
  const stats = document.createElement('div');
  stats.className = 'stat-line';
  for (const htm of statHtml) {
    const sp = document.createElement('span');
    sp.innerHTML = htm;   // 数字由本页面 fmt 生成，非外部数据
    stats.appendChild(sp);
  }
  const chartWrap = document.createElement('div');
  chartWrap.className = 'chart-wrap';
  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap hidden';
  const note = document.createElement('p');
  note.className = 'note'; note.textContent = noteText;
  card.append(head, stats, chartWrap, tableWrap, note);

  const bands = [];
  ctx.idx.forEach((w, j) => { if (ctx.node.censored[w]) bands.push({ x: j, color: cssVar('--critical') }); });
  drawLineChart(chartWrap, {
    series, bands, weekIdx: ctx.idx,
    flagsFor: (j) => weekFlags(ctx.node, ctx.idx[j]),
    legendExtra: bands.length ? [{ kind: 'band', color: cssVar('--critical'), label: '缺货截断周' }] : [],
  });
  buildTable(tableWrap, ctx.idx, series, (j) => weekFlags(ctx.node, ctx.idx[j]));
  btn.addEventListener('click', () => {
    const showTable = tableWrap.classList.contains('hidden');
    tableWrap.classList.toggle('hidden', !showTable);
    chartWrap.classList.toggle('hidden', showTable);
    btn.textContent = showTable ? '图表视图' : '表格视图';
  });
  return card;
}

// ---------- 情景回放 ----------
function renderScenario(ctx) {
  const card = $('card-scenario');
  if (ctx.kind === 'store') { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const scopeKey = ctx.kind === 'network' ? 'ALL' : state.scope;
  const scen = DATA.scenarios[state.sku][scopeKey];
  const { idx, node, flows } = ctx;
  const demand = pick(flows.demand, idx);
  const cens = pick(node.censored, idx);

  // 热力图：9 个情景的模拟波动比
  const hm = $('heatmap');
  hm.textContent = '';
  const corner = document.createElement('span'); corner.className = 'hm-axis'; corner.textContent = '频率＼提前期';
  hm.appendChild(corner);
  for (const L of META.scenarioGrid.L) {
    const h = document.createElement('span'); h.className = 'hm-axis'; h.textContent = `${L} 周`;
    hm.appendChild(h);
  }
  const cells = [];
  for (const R of META.scenarioGrid.R) {
    const rh = document.createElement('span'); rh.className = 'hm-row'; rh.textContent = `每 ${R} 周`;
    hm.appendChild(rh);
    for (const L of META.scenarioGrid.L) {
      const sim = scen[`R${R}-L${L}`];
      const m = ratioMetric(demand, pick(sim.orders, idx), { kind: state.metric, exclude: cens });
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hm-cell' + (R === state.R && L === state.L ? ' selected' : '');
      if (m.status === 'ok') {
        b.textContent = m.value.toFixed(2);
        cells.push({ el: b, v: m.value });
      } else {
        b.textContent = REASON_LABELS[m.reason];
        b.classList.add('nc');
        b.style.background = 'transparent';
        b.style.color = cssVar('--text-muted');
      }
      b.addEventListener('click', () => {
        state.R = R; state.L = L;
        $('f-R').value = String(R); $('f-L').value = String(L);
        render();
      });
      hm.appendChild(b);
    }
  }
  // 顺序色阶：按 9 格取值 min..max 映射 6 档
  const seq = ['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-500', '--seq-600'];
  const vals = cells.map((c) => c.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  for (const c of cells) {
    const t = hi > lo ? (c.v - lo) / (hi - lo) : 0;
    const step = Math.min(5, Math.floor(t * 6));
    c.el.style.background = cssVar(seq[step]);
    c.el.style.color = step >= 3 ? '#ffffff' : '#0b0b0b';
  }
  $('heatmap-note').textContent =
    `指标：${state.metric === 'var' ? '方差比' : 'CV² 比'}（模拟 DC 订货 / 观察门店需求，缺货截断周已剔除）。点击格子切换情景。`;

  // 情景对比图
  const sim = scen[`R${state.R}-L${state.L}`];
  $('scenario-title').textContent = `实际 vs 模拟 DC 订货（每 ${state.R} 周订货 · 提前期 ${state.L} 周）`;
  const simLost = pick(sim.lost, idx);
  const bands = [];
  simLost.forEach((v, j) => { if (v > 0) bands.push({ x: j, color: cssVar('--critical') }); });
  const series = [
    { name: '门店需求（观察）', color: cssVar('--s1'), values: demand },
    { name: 'DC 订货（实际）', color: cssVar('--s3'), values: pick(flows.dcOrders, idx) },
    { name: 'DC 订货（模拟）', color: cssVar('--s3'), dashed: true, values: pick(sim.orders, idx) },
  ];
  drawLineChart($('chart-scenario'), {
    series, bands, weekIdx: idx,
    flagsFor: (j) => {
      const f = weekFlags(node, idx[j]);
      if (simLost[j] > 0) f.push({ text: `模拟缺货 ${fmt.format(simLost[j])} 件`, crit: true });
      return f;
    },
    legendExtra: bands.length ? [{ kind: 'band', color: cssVar('--critical'), label: '模拟缺货周' }] : [],
  });
  buildTable($('table-scenario'), idx, series, (j) => {
    const f = weekFlags(node, idx[j]);
    if (simLost[j] > 0) f.push({ text: `模拟缺货 ${fmt.format(simLost[j])} 件`, crit: true });
    return f;
  });

  // 情景 KPI
  const kpis = $('sim-kpis');
  kpis.textContent = '';
  const mAct = ratioMetric(demand, pick(flows.dcOrders, idx), { kind: state.metric, exclude: cens });
  const mSim = ratioMetric(demand, pick(sim.orders, idx), { kind: state.metric, exclude: cens });
  kpis.appendChild(tile('实际波动比（观察）', mAct.status === 'ok' ? mAct.value.toFixed(2) + '×' : '不可比较',
    mAct.status === 'ok' ? `可比 ${mAct.n} 周` : REASON_LABELS[mAct.reason]));
  kpis.appendChild(tile('模拟波动比', mSim.status === 'ok' ? mSim.value.toFixed(2) + '×' : '不可比较',
    mSim.status === 'ok' ? `可比 ${mSim.n} 周` : REASON_LABELS[mSim.reason]));
  kpis.appendChild(tile('模拟满足率', sim.fillRate == null ? '—' : (sim.fillRate * 100).toFixed(1) + '%',
    `模拟缺货 ${fmt.format(pick(sim.lost, idx).reduce((a, b) => a + b, 0))} 件`));
}

// ---------- 指标钻取 ----------
function openDrilldown(pair) {
  const ctx = resolveCtx();
  const { node, idx, flows } = ctx;
  const m = metricFor(flows[pair.down], flows[pair.up], idx, node.censored);
  $('modal-title').textContent = `${pair.name} · ${state.metric === 'var' ? '方差比' : 'CV² 比'}`;
  const body = $('modal-body');
  body.textContent = '';

  const head = document.createElement('div');
  head.className = 'stat-line';
  const addStat = (txt) => { const s = document.createElement('span'); s.textContent = txt; head.appendChild(s); };
  if (m.status === 'ok') {
    addStat(`比值 ${m.value.toFixed(3)}×`);
  } else {
    addStat(`不可比较：${REASON_LABELS[m.reason]}`);
  }
  addStat(`可比周数 ${m.n}（要求 ≥${MIN_PERIODS}）`);
  if (m.downMean !== undefined) {
    addStat(`下游 均值 ${m.downMean.toFixed(1)} / 方差 ${fmt.format(Math.round(m.downVar))}`);
    addStat(`上游 均值 ${m.upMean.toFixed(1)} / 方差 ${fmt.format(Math.round(m.upVar))}`);
  }
  body.appendChild(head);
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = `剔除缺货截断周后成对计算；均值接近零（<${MEAN_EPS} 件/周）或分母方差为零时判为不可比较。`;
  body.appendChild(note);

  const downName = SERIES_DEFS.find((d) => d.key === pair.down).name;
  const upName = SERIES_DEFS.find((d) => d.key === pair.up).name;
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const t of ['周', downName + '（下游）', upName + '（上游）', '计入指标', '标记']) {
    const th = document.createElement('th'); th.textContent = t; trh.appendChild(th);
  }
  thead.appendChild(trh); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  idx.forEach((w) => {
    const tr = document.createElement('tr');
    const c0 = document.createElement('td'); c0.textContent = `${META.weeks[w].label} ${META.weeks[w].start}`;
    const c1 = document.createElement('td'); c1.textContent = fmt.format(flows[pair.down][w]);
    const c2 = document.createElement('td'); c2.textContent = fmt.format(flows[pair.up][w]);
    const c3 = document.createElement('td');
    c3.textContent = node.censored[w] ? '否（缺货截断）' : '是';
    if (node.censored[w]) c3.className = 'flag crit';
    const c4 = document.createElement('td');
    c4.textContent = weekFlags(node, w).map((f) => f.text).join('；');
    tr.append(c0, c1, c2, c3, c4);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  body.appendChild(table);
  $('modal-backdrop').classList.remove('hidden');
}
function closeModal() { $('modal-backdrop').classList.add('hidden'); }

init();
