// 数据集契约测试：校验 app.js 依赖的字段形状，并打印主指标供目检。
// node tests/test_dataset_contract.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ratioMetric } from '../web/metrics.js';

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL('../web/data/dataset.js', import.meta.url), 'utf8'), sandbox);
const DATA = sandbox.window.DATASET;
const M = DATA.meta;
const N = M.weeks.length;
const idx = Array.from({ length: N }, (_, i) => i);
const pick = (a) => idx.map((i) => a[i]);

// 1. meta 形状
for (const k of ['grain', 'unit', 'weeks', 'censorShare', 'products', 'stores', 'dcs', 'scenarioGrid'])
  assert.ok(k in M, `meta 缺 ${k}`);
assert.equal(M.scenarioGrid.R.length, 3);
assert.equal(M.scenarioGrid.L.length, 3);

// 2. 周序列字段（与 app.js 引用一致）
const SERIES26 = ['sales', 'orders', 'deliveries', 'inventory', 'lost', 'returns',
  'stockoutDays', 'censored', 'minorStockout', 'promo'];
for (const p of M.products) {
  const w = DATA.weekly[p.id];
  for (const s of M.stores) {
    for (const k of SERIES26) assert.equal(w.store[s.id][k].length, N, `${p.id}.${s.id}.${k}`);
  }
  for (const node of [...M.dcs.map((d) => w.dc[d.id]), w.network]) {
    for (const k of ['storeSales', 'storeOrders', 'dcOrders', 'dcDeliveries',
      'dcDeliveriesPromised', 'inventory', 'backlog', 'lost', 'returns',
      'stockoutDays', 'censored', 'minorStockout', 'promo'])
      assert.equal(node[k].length, N, `dc/network ${k}`);
    assert.ok(Array.isArray(node.delayedWeeks));
  }
}

// 3. 情景键可解析
for (const p of M.products)
  for (const scope of ['ALL', ...M.dcs.map((d) => d.id)])
    for (const R of M.scenarioGrid.R)
      for (const L of M.scenarioGrid.L) {
        const sc = DATA.scenarios[p.id][scope][`R${R}-L${L}`];
        assert.equal(sc.orders.length, N);
        assert.equal(sc.inventory.length, N);
        assert.equal(sc.lost.length, N);
      }

// 4. 主指标（网络范围，全部 26 周）——打印供目检，不断言方向（避免把样本故事写死）
console.log('网络范围 · 全部 26 周 · 方差比 / CV²比（缺货截断周已剔除）');
for (const p of M.products) {
  const n = DATA.weekly[p.id].network;
  const pairs = [
    ['门店订货/门店需求', n.storeSales, n.storeOrders],
    ['DC订货/门店订货', n.storeOrders, n.dcOrders],
    ['供应商交付/DC订货', n.dcOrders, n.dcDeliveries],
  ];
  const cells = pairs.map(([name, d, u]) => {
    const v = ratioMetric(pick(d), pick(u), { kind: 'var', exclude: n.censored });
    const c = ratioMetric(pick(d), pick(u), { kind: 'cv2', exclude: n.censored });
    const fmt = (m) => (m.status === 'ok' ? m.value.toFixed(2) : `不可比较(${m.reason})`);
    return `${name}: ${fmt(v)} / ${fmt(c)}`;
  });
  console.log(`  ${p.id} ${p.name}: ${cells.join(' | ')}`);
}

// 5. 最近 8 周必然周期不足（守卫在真实数据上生效）
{
  const idx8 = idx.slice(-8);
  const n = DATA.weekly[M.products[0].id].network;
  const m = ratioMetric(idx8.map((i) => n.storeSales[i]), idx8.map((i) => n.storeOrders[i]),
    { kind: 'var', exclude: idx8.map((i) => n.censored[i]) });
  assert.equal(m.status, 'not-comparable');
  assert.equal(m.reason, 'insufficient-periods');
  console.log('  最近 8 周切片 -> 不可比较(周期不足)，守卫生效');
}

console.log('test_dataset_contract: 全部契约校验通过');
