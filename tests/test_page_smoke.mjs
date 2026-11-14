// 页面冒烟测试：在 jsdom 中加载真实 index.html + dataset.js + app.js，
// 验证渲染、筛选、钻取与守卫在页面上生效。node tests/test_page_smoke.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/tmp/domtest/');
const { JSDOM } = require('jsdom');

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;

// 挂载全局，供 app.js 使用
globalThis.window = window;
globalThis.document = window.document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
window.DATASET = JSON.parse(readFileSync(new URL('../web/data/dataset.json', import.meta.url), 'utf8'));

await import('../web/app.js');
const $ = (id) => window.document.getElementById(id);
const q = (sel) => window.document.querySelectorAll(sel);

// 1. 初始渲染（全网络）：KPI = 3 基础 + 3 指标卡；主图 4 条序列线；分层 3 卡；热力图 9 格
assert.equal(q('#kpi-row .tile').length, 6);
assert.equal(q('#kpi-row .tile.metric').length, 3);
assert.equal(q('#chart-main svg path[fill="none"]').length, 4);
assert.equal(q('#echelon-grid > .card').length, 3);
assert.equal(q('#heatmap .hm-cell').length, 9);
assert.ok(!$('card-scenario').classList.contains('hidden'));
// 图例存在（>=2 序列）
assert.ok(q('#chart-main .legend .item').length >= 4);
// 缺货截断周底纹存在（SKU-1001 第 9、10 周）
assert.ok(q('#chart-main svg rect[opacity="0.12"]').length >= 2);

// 2. 指标卡数值与钻取
const firstMetric = q('#kpi-row .tile.metric')[0];
assert.match(firstMetric.textContent, /×|不可比较/);
firstMetric.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.ok(!$('modal-backdrop').classList.contains('hidden'));
assert.match($('modal-title').textContent, /门店订货 \/ 门店需求/);
assert.equal(q('#modal-body tbody tr').length, 26);   // 26 周逐周列出
assert.match($('modal-body').textContent, /可比周数 24/); // 剔除 2 个截断周
$('modal-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.ok($('modal-backdrop').classList.contains('hidden'));

// 3. 切到最近 8 周 -> 周期不足，不显示无穷大
$('f-range').value = 'recent8';
$('f-range').dispatchEvent(new window.Event('change'));
const tiles = [...q('#kpi-row .tile.metric')];
assert.ok(tiles.every((t) => t.textContent.includes('不可比较')));
assert.ok(tiles.every((t) => t.textContent.includes('周期不足')));
assert.ok(![...q('#kpi-row')].some((t) => t.textContent.includes('Infinity')));
// 热力图格也显示周期不足
assert.ok([...q('#heatmap .hm-cell')].every((c) => c.textContent.includes('周期不足')));
$('f-range').value = 'all';
$('f-range').dispatchEvent(new window.Event('change'));

// 4. 切到单店范围：DC/供应商层隐藏，情景区隐藏，指标卡只剩 1 张
$('f-scope').value = 'S01';
$('f-scope').dispatchEvent(new window.Event('change'));
assert.equal(q('#kpi-row .tile.metric').length, 1);
assert.equal(q('#chart-main svg path[fill="none"]').length, 2);
assert.ok($('card-scenario').classList.contains('hidden'));
assert.match($('echelon-grid').textContent, /单店范围不包含 DC/);

// 5. 切到 DC 范围：三层齐全，情景区恢复
$('f-scope').value = 'DC-N';
$('f-scope').dispatchEvent(new window.Event('change'));
assert.equal(q('#kpi-row .tile.metric').length, 3);
assert.ok(!$('card-scenario').classList.contains('hidden'));

// 6. 点击热力图格 -> 情景选择同步到筛选器
const cell = [...q('#heatmap .hm-cell')].find((c) => !c.classList.contains('selected'));
cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.equal(q('#heatmap .hm-cell.selected').length, 1);

// 7. 表格视图切换
const toggle = window.document.querySelector('.table-toggle[data-target="main"]');
toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.ok(!$('table-main').classList.contains('hidden'));
assert.ok($('chart-main').classList.contains('hidden'));
assert.equal(q('#table-main tbody tr').length, 26);
toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.ok($('table-main').classList.contains('hidden'));

// 8. 主题切换不报错且重渲染
$('theme-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.equal(window.document.documentElement.dataset.theme, 'dark');
assert.equal(q('#chart-main svg path[fill="none"]').length, 4);

// 9. 换商品（SKU-2002 批量订货）渲染正常
$('f-sku').value = 'SKU-2002';
$('f-sku').dispatchEvent(new window.Event('change'));
assert.equal(q('#chart-main svg path[fill="none"]').length, 4);
assert.match($('kpi-row').textContent, /×/);

console.log('test_page_smoke: 全部 9 组页面断言通过');
