// 波动指标：方差比 / 变异系数平方比，含不可比较守卫。
// 浏览器（ES module）与 Node（测试）共用，保证页面数字与测试一致。

export const MIN_PERIODS = 10;   // 可比周期下限
export const MEAN_EPS = 1.0;     // 均值接近零阈值（件/周）
export const VAR_EPS = 1e-9;     // 方差为零阈值

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function variance(xs) {           // 样本方差 (ddof=1)
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
}

export function cv2(xs) {
  const m = mean(xs), v = variance(xs);
  return (m * m > 0 && !Number.isNaN(v)) ? v / (m * m) : NaN;
}

/**
 * 计算上游/下游波动比。
 * @param down 下游序列（如门店需求）
 * @param up   上游序列（如门店订货），与 down 同周对齐
 * @param opts.kind  'var' 方差比 | 'cv2' 变异系数平方比
 * @param opts.exclude 布尔数组：true 的周（如缺货截断周）从两条序列成对剔除
 * @returns {status:'ok', value, n, ...} | {status:'not-comparable', reason, n, ...}
 *   reason: 'insufficient-periods' | 'denominator-zero' | 'mean-near-zero'
 */
export function ratioMetric(down, up, opts = {}) {
  const kind = opts.kind || 'var';
  const exclude = opts.exclude || down.map(() => false);
  const minPeriods = opts.minPeriods ?? MIN_PERIODS;
  const meanEps = opts.meanEps ?? MEAN_EPS;

  const d = [], u = [];
  for (let i = 0; i < down.length; i++) {
    if (!exclude[i]) { d.push(down[i]); u.push(up[i]); }
  }
  const n = d.length;
  const base = { n, kind };
  if (n < minPeriods) {
    return { status: 'not-comparable', reason: 'insufficient-periods', ...base };
  }
  const dMean = mean(d), uMean = mean(u);
  const dVar = variance(d), uVar = variance(u);
  const detail = { ...base, downMean: dMean, upMean: uMean, downVar: dVar, upVar: uVar };
  if (dVar <= VAR_EPS) {
    return { status: 'not-comparable', reason: 'denominator-zero', ...detail };
  }
  if (Math.abs(dMean) < meanEps || Math.abs(uMean) < meanEps) {
    return { status: 'not-comparable', reason: 'mean-near-zero', ...detail };
  }
  if (kind === 'cv2') {
    const dCv2 = dVar / (dMean * dMean), uCv2 = uVar / (uMean * uMean);
    return { status: 'ok', value: uCv2 / dCv2, downCv2: dCv2, upCv2: uCv2, ...detail };
  }
  return { status: 'ok', value: uVar / dVar, ...detail };
}

export const REASON_LABELS = {
  'insufficient-periods': '周期不足',
  'denominator-zero': '分母为零',
  'mean-near-zero': '均值接近零',
};
