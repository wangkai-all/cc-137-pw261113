# 需求波动向上游传递观察台（牛鞭效应观察）

把门店销量、配送中心（DC）订货和供应商交付放到**同一条周时间轴**上，观察需求波动如何向上游传递。
纯本地样本数据 + 静态页面，无需构建、无需外部服务。

## 快速开始

```bash
# 1. 生成样本数据（确定性，种子固定）-> data/sample/*.csv
python3 pipeline/generate_sample.py

# 2. 对齐周粒度 + 计算情景回放 -> web/data/dataset.json / dataset.js
python3 pipeline/build_dataset.py

# 3. 打开页面（二选一）
python3 -m http.server 8000 --directory web   # 然后访问 http://localhost:8000
# 或直接用浏览器打开 web/index.html（dataset.js 以 <script> 内联，file:// 可用）
```

## 页面功能

- **筛选行**（一行，作用于全部内容）：商品、网络范围（全网络 / DC / 单店）、
  波动指标（方差比 / CV² 比）、周期（全部 26 周 / 前 13 / 后 13 / 最近 8 周）、
  情景参数（订货频率 × 补货提前期）。
- **主图（观察事实）**：门店销量、门店订货、DC 订货、供应商交付四条周序列同轴对齐；
  缺货截断周红色底纹、促销周三角标、延迟到货菱形标；悬停十字线查看全序列数值；可切表格视图。
- **指标卡**：三层波动比（门店订货/门店需求、DC 订货/门店订货、供应商交付/DC 订货），
  点击钻取可看到**逐周使用了哪些周期数据**（含剔除原因）。
- **分层卡片**：门店层（销量+库存）、DC 层（订货+库存+积压）、供应商层（实际 vs 承诺交付）。
- **情景回放（模拟输出）**：3×3 热力图（订货频率 × 提前期 → 模拟波动比），
  实际 vs 模拟 DC 订货对比曲线、模拟满足率。回放只读取观察需求，**不改写原始数据**。

## 口径约定（与页面“口径与读法”一致）

| 事项 | 处理 |
|---|---|
| 时间粒度 | 全部层级统一为周（周一~周日，26 周）；周订货不与日销量直接比较 |
| 单位 | 统一为件；订货以箱记录，按箱规换算（门店合并同理，先换算再求和） |
| 退货 | 单独列示，不冲减需求与订货 |
| 缺货截断 | 周损失量 ≥ 当周需求 2% 记为截断周，指标中成对剔除并标红；0~2% 记轻微缺货，保留但标记 |
| 不可比较 | 分母方差为零 / 均值接近零（<1 件/周）/ 可比周期不足 10 周 → 显示“不可比较”及原因，不给无穷大排名 |
| 观察 vs 模拟 | 主图与分层卡为观察值；情景区为模拟输出，分区标注 |

样本网络：供应商 → 2 个 DC → 各 3 家门店；3 个商品（箱规 12/6/24）。
样本特意包含：DC 批量订货（MOQ/整批）、两场促销、4 单延迟交付、门店缺货截断、顾客退货与一起破损集中退货。

## 目录

```
pipeline/generate_sample.py   样本生成器（stdlib，种子 20261114）
pipeline/build_dataset.py     周粒度对齐 + 情景回放模拟
web/index.html / styles.css / app.js / metrics.js
web/data/dataset.json|js      管线输出（页面数据源）
tests/test_metrics.mjs        指标守卫单测（node）
tests/test_pipeline.py        数据集完整性校验（python3）
tests/test_dataset_contract.mjs  页面-数据契约 + 主指标目检（node）
tests/test_page_smoke.mjs     jsdom 页面冒烟测试（node，需 jsdom）
```

## 测试

```bash
node tests/test_metrics.mjs          # 指标与守卫
python3 tests/test_pipeline.py       # 对齐/换算/退货/截断/确定性
node tests/test_dataset_contract.mjs # 字段契约 + 打印主指标
node tests/test_page_smoke.mjs       # 页面渲染（需先 npm i jsdom，见文件头）
```

## 读法提醒

波动放大是系统现象：批量订货、促销、提前期、缺货截断都可能贡献放大。
本工具展示事实与情景，**不能仅凭波动放大就断言某一层操作有错**。
