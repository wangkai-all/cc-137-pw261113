// 指标守卫与计算的单测：node tests/test_metrics.mjs
import assert from 'node:assert/strict';
import { ratioMetric, variance, cv2, MIN_PERIODS } from '../web/metrics.js';

const flat = (v, n = 26) => Array(n).fill(v);
const ramp = (n = 26) => Array.from({ length: n }, (_, i) => 100 + (i % 5) * 10);

// 1. 正常方差比：上游方差是下游 4 倍 -> 比值 4
{
  const down = ramp();
  const up = down.map(x => 200 + (x - 120) * 2); // 同均值结构、振幅×2 -> 方差×4
  const r = ratioMetric(down, up, { kind: 'var' });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.value - 4) < 1e-9, `期望 4，实得 ${r.value}`);
  assert.equal(r.n, 26);
}

// 2. CV² 比：均值不同、相对波动相同 -> 比值 1
{
  const down = ramp();
  const up = down.map(x => x * 3); // 均值×3、std×3 -> CV² 相同
  const r = ratioMetric(down, up, { kind: 'cv2' });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.value - 1) < 1e-9, `期望 1，实得 ${r.value}`);
}

// 3. 分母（下游）方差为零 -> 不可比较，而不是 Infinity
{
  const r = ratioMetric(flat(100), ramp(), { kind: 'var' });
  assert.equal(r.status, 'not-comparable');
  assert.equal(r.reason, 'denominator-zero');
  assert.ok(!Number.isFinite(r.value ?? 0) === false); // 没有 value 字段
}

// 4. 均值接近零 -> 不可比较（下游均值为 0）
{
  const down = Array.from({ length: 26 }, (_, i) => (i % 2 ? 1 : -1)); // 均值 0
  const r = ratioMetric(down, ramp(), { kind: 'var' });
  assert.equal(r.status, 'not-comparable');
  assert.equal(r.reason, 'mean-near-zero');
}

// 5. 周期不足：剔除缺货周后不足 MIN_PERIODS -> 不可比较
{
  const exclude = flat(false).map((_, i) => i >= 8); // 18 周被剔除，剩 8 周
  const r = ratioMetric(ramp(), ramp(), { kind: 'var', exclude });
  assert.equal(r.status, 'not-comparable');
  assert.equal(r.reason, 'insufficient-periods');
  assert.equal(r.n, 8);
  assert.ok(MIN_PERIODS > 8);
}

// 6. 缺货截断周成对剔除：被剔除周的极端值不影响结果
{
  const down = ramp();
  const up = ramp().map(x => x * 1.5);
  down[3] = 5; up[3] = 99999;      // 第 3 周是缺货截断周，数值不可信
  const excl = flat(false); excl[3] = true;
  const a = ratioMetric(down, up, { kind: 'var', exclude: excl });
  const b = ratioMetric(down.filter((_, i) => i !== 3), up.filter((_, i) => i !== 3), { kind: 'var' });
  assert.equal(a.status, 'ok');
  assert.equal(a.n, 25);
  assert.ok(Math.abs(a.value - b.value) < 1e-9);
}

// 7. 守卫优先级：周期不足先于分母为零
{
  const r = ratioMetric(flat(0, 5), flat(0, 5), { kind: 'var' });
  assert.equal(r.reason, 'insufficient-periods');
}

// 8. variance / cv2 基础值
{
  assert.ok(Math.abs(variance([1, 2, 3]) - 1) < 1e-12);
  const xs = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.ok(Math.abs(variance(xs) - 32 / 7) < 1e-9);
  assert.ok(Math.abs(cv2(xs) - (32 / 7) / 25) < 1e-9);
}

console.log('test_metrics: 全部 8 组断言通过');
