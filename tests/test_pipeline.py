#!/usr/bin/env python3
"""数据集完整性校验：python3 tests/test_pipeline.py（需先生成样本与数据集）。"""
import csv
import json
import os
import subprocess
import sys
from collections import defaultdict
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE = os.path.join(ROOT, "data", "sample")
DATASET = os.path.join(ROOT, "web", "data", "dataset.json")


def load(name):
    with open(os.path.join(SAMPLE, name), encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    d = json.load(open(DATASET, encoding="utf-8"))
    meta = d["meta"]
    n = len(meta["weeks"])
    start = date.fromisoformat(meta["weeks"][0]["start"])
    pack = {p["id"]: p["pack"] for p in meta["products"]}

    # 1. 周界对齐：周一到周日、连续 7 天、26 周
    assert meta["weeks"][0]["start"] == "2026-05-18" and start.weekday() == 0
    for i, w in enumerate(meta["weeks"]):
        ws, we = date.fromisoformat(w["start"]), date.fromisoformat(w["end"])
        assert ws.weekday() == 0 and (we - ws).days == 6, f"第{i}周边界错误"
        if i:
            assert (ws - date.fromisoformat(meta["weeks"][i - 1]["start"])).days == 7

    # 2. 所有周序列长度一致（同一时间粒度）
    def check_len(node, path):
        for k, v in node.items():
            if k == "delayedWeeks":   # 稀疏周序号列表，非周序列
                continue
            if isinstance(v, list):
                assert len(v) == n, f"{path}.{k} 长度 {len(v)} != {n}"
            elif isinstance(v, dict):
                check_len(v, f"{path}.{k}")
    for sku, blk in d["weekly"].items():
        for st, s in blk["store"].items():
            check_len(s, f"{sku}.{st}")
        for dc, s in blk["dc"].items():
            check_len(s, f"{sku}.{dc}")
        check_len(blk["network"], f"{sku}.network")

    # 3. 箱->件换算：抽 SKU-1001 网络层门店订货 = Σ(箱×12)
    sku = "SKU-1001"
    expect = defaultdict(int)
    for r in load("store_orders.csv"):
        if r["sku"] == sku:
            wk = (date.fromisoformat(r["order_date"]) - start).days // 7
            expect[wk] += int(r["cases"]) * pack[sku]
    got = d["weekly"][sku]["network"]["storeOrders"]
    for i in range(n):
        assert got[i] == expect[i], f"第{i}周门店订货换算不符: {got[i]} != {expect[i]}"

    # 4. 退货单独列示：需求(销量)不含退货，returns 与 CSV 一致
    ret_csv = defaultdict(int)
    for r in load("store_returns_daily.csv"):
        if r["sku"] == sku:
            ret_csv[(date.fromisoformat(r["date"]) - start).days // 7] += int(r["qty"])
    net = d["weekly"][sku]["network"]
    sales_csv = defaultdict(int)
    for r in load("store_sales_daily.csv"):
        if r["sku"] == sku:
            sales_csv[(date.fromisoformat(r["date"]) - start).days // 7] += int(r["qty"])
    for i in range(n):
        assert net["returns"][i] == ret_csv[i], f"第{i}周退货不一致"
        assert net["storeSales"][i] == sales_csv[i], f"第{i}周销量被退货污染"

    # 5. 缺货截断标记与损失占比一致（>=2% 需求）
    lost_csv = defaultdict(int)
    for r in load("store_stockouts_daily.csv"):
        if r["sku"] == sku:
            lost_csv[(date.fromisoformat(r["date"]) - start).days // 7] += int(r["lost_qty"])
    for i in range(n):
        dem = net["storeSales"][i] + lost_csv[i]
        share = lost_csv[i] / dem if dem else 0
        assert net["censored"][i] == (share >= meta["censorShare"]), f"第{i}周截断标记错误"
        assert net["lost"][i] == lost_csv[i]

    # 6. 情景确定性：重跑管线，情景块逐字节一致；且原始周序列不受情景影响
    before = open(DATASET, "rb").read()
    subprocess.run([sys.executable, os.path.join(ROOT, "pipeline", "build_dataset.py")],
                   check=True, capture_output=True)
    after = open(DATASET, "rb").read()
    assert before == after, "管线非确定性：重跑结果不一致"

    # 7. 情景网格完整（3 频率 × 3 提前期 × 3 范围 × 3 商品）
    grid = meta["scenarioGrid"]
    for sku2 in [p["id"] for p in meta["products"]]:
        for scope in ["ALL", "DC-N", "DC-S"]:
            for R in grid["R"]:
                for L in grid["L"]:
                    sc = d["scenarios"][sku2][scope][f"R{R}-L{L}"]
                    assert len(sc["orders"]) == n and sc["fillRate"] is not None

    # 8. 延迟交付确实落在样本里
    assert sum(len(blk["dc"][dc]["delayedWeeks"]) for blk in d["weekly"].values()
               for dc in blk["dc"]) >= 4

    print("test_pipeline: 全部 8 组校验通过")


if __name__ == "__main__":
    main()
