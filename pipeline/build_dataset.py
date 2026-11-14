#!/usr/bin/env python3
"""把 data/sample/ 的日粒度原始数据对齐到统一的周粒度，生成 web/data/dataset.json。

口径约定（与页面说明一致）：
- 统一时间粒度：周（周一~周日，26 周），各层相同；日销量不与周订货直接比较。
- 统一单位：件。门店/DC 订货以箱记录，按箱规换算为件。
- 退货单独列示，不冲减需求与订货。
- 缺货截断：某周损失量 >= 当周需求(销量+损失) 的 2% 记为“缺货截断周”，
  波动指标中剔除；0~2% 记为“轻微缺货”，保留但标记。
- 历史回放（情景模拟）只读取原始周需求，输出独立的模拟序列，不改原始数据。
"""
import csv
import json
import math
import os
from collections import defaultdict
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE = os.path.join(HERE, "..", "data", "sample")
OUT = os.path.join(HERE, "..", "web", "data", "dataset.json")

CENSOR_SHARE = 0.02          # 缺货损失占需求比例 >= 2% -> 截断周
SCENARIO_R = [1, 2, 4]       # 订货频率（周）
SCENARIO_L = [1, 2, 3]       # 补货提前期（周）
FORECAST_WIN = 4             # 情景预测窗口（周）
SAFETY_WEEKS = 1.0           # 情景安全库存（周）


def load_csv(name):
    with open(os.path.join(SAMPLE, name), encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    meta = json.load(open(os.path.join(SAMPLE, "meta.json"), encoding="utf-8"))
    start = date.fromisoformat(meta["start"])
    n_weeks = meta["weeks"]
    products = meta["products"]
    skus = sorted(products)
    pack = {sku: products[sku]["pack"] for sku in skus}
    stores = meta["stores"]
    dcs = meta["dcs"]
    dc_names = sorted(dcs)
    store_dc = {s: d for d, ss in dcs.items() for s in ss}
    weeks = [{"i": i, "label": f"W{i+1:02d}",
              "start": str(start + timedelta(days=7 * i)),
              "end": str(start + timedelta(days=7 * i + 6))} for i in range(n_weeks)]

    def wk(dstr):
        return (date.fromisoformat(dstr) - start).days // 7

    def wk_in(dstr):
        """窗口内返回周序号，窗口外（如延迟交付越过期末）返回 None，不计入。"""
        i = wk(dstr)
        return i if 0 <= i < n_weeks else None

    def zeros():
        return [0] * n_weeks

    # ---- 门店层周聚合 ----
    sales = defaultdict(zeros)       # (sku, store) -> [qty]*26
    lost = defaultdict(zeros)
    returns = defaultdict(zeros)
    st_orders = defaultdict(zeros)   # 件
    st_deliv = defaultdict(zeros)
    st_inv = {}                      # (sku, store) -> 周末库存
    st_stockout_days = defaultdict(zeros)
    for r in load_csv("store_sales_daily.csv"):
        sales[(r["sku"], r["store"])][wk(r["date"])] += int(r["qty"])
    for r in load_csv("store_stockouts_daily.csv"):
        k = (r["sku"], r["store"])
        lost[k][wk(r["date"])] += int(r["lost_qty"])
        st_stockout_days[k][wk(r["date"])] += 1
    for r in load_csv("store_returns_daily.csv"):
        returns[(r["sku"], r["store"])][wk(r["date"])] += int(r["qty"])
    for r in load_csv("store_orders.csv"):
        st_orders[(r["sku"], r["store"])][wk(r["order_date"])] += int(r["cases"]) * pack[r["sku"]]
    for r in load_csv("store_deliveries.csv"):
        st_deliv[(r["sku"], r["store"])][wk(r["date"])] += int(r["cases"]) * pack[r["sku"]]
    inv_tmp = defaultdict(dict)
    for r in load_csv("store_inventory_daily.csv"):
        inv_tmp[(r["sku"], r["store"])][wk(r["date"])] = int(r["eoh_qty"])  # 周末为最后一条
    for k, bywk in inv_tmp.items():
        st_inv[k] = [bywk.get(i, 0) for i in range(n_weeks)]

    # 促销标记
    promo_weeks = defaultdict(set)   # (sku, store) -> {week}
    for r in load_csv("promotions.csv"):
        for i in range(wk(r["start"]), wk(r["end"]) + 1):
            promo_weeks[(r["sku"], r["store"])].add(i)

    def flags(sku, store_list):
        """聚合范围内各周的 截断/轻微缺货/促销 标记与损失、退货合计。"""
        censored, minor, promo = [], [], []
        lost_sum, ret_sum, sod = zeros(), zeros(), zeros()
        for i in range(n_weeks):
            s = sum(sales[(sku, st)][i] for st in store_list)
            l = sum(lost[(sku, st)][i] for st in store_list)
            lost_sum[i], ret_sum[i] = l, sum(returns[(sku, st)][i] for st in store_list)
            sod[i] = sum(st_stockout_days[(sku, st)][i] for st in store_list)
            share = l / (s + l) if (s + l) > 0 else 0.0
            censored.append(share >= CENSOR_SHARE)
            minor.append(0 < share < CENSOR_SHARE)
            promo.append(any(i in promo_weeks.get((sku, st), ()) for st in store_list))
        return {"censored": censored, "minorStockout": minor, "promo": promo,
                "lost": lost_sum, "returns": ret_sum, "stockoutDays": sod}

    def sum_series(table, sku, store_list):
        out = zeros()
        for st in store_list:
            src = table.get((sku, st)) or zeros()
            for i in range(n_weeks):
                out[i] += src[i]
        return out

    # ---- DC 层与网络层周聚合 ----
    dc_orders = defaultdict(zeros)
    dc_deliv = defaultdict(zeros)
    dc_deliv_promised = defaultdict(zeros)
    for r in load_csv("dc_orders.csv"):
        dc_orders[(r["sku"], r["dc"])][wk(r["order_date"])] += int(r["cases"]) * pack[r["sku"]]
    delayed_weeks = defaultdict(set)  # (sku, dc) -> {实际到货周}
    for r in load_csv("dc_deliveries.csv"):
        k = (r["sku"], r["dc"])
        wa, wp = wk_in(r["actual_date"]), wk_in(r["promised_date"])
        if wa is not None:
            dc_deliv[k][wa] += int(r["cases"]) * pack[r["sku"]]
        if wp is not None:
            dc_deliv_promised[k][wp] += int(r["cases"]) * pack[r["sku"]]
        if r["actual_date"] > r["promised_date"] and wa is not None:
            delayed_weeks[k].add(wa)
    dc_inv_tmp, dc_bl_tmp = defaultdict(dict), defaultdict(dict)
    for r in load_csv("dc_inventory_daily.csv"):
        dc_inv_tmp[(r["sku"], r["dc"])][wk(r["date"])] = int(r["eoh_qty"])
        dc_bl_tmp[(r["sku"], r["dc"])][wk(r["date"])] = int(r["backlog_qty"])
    dc_inv = {k: [v.get(i, 0) for i in range(n_weeks)] for k, v in dc_inv_tmp.items()}
    dc_bl = {k: [v.get(i, 0) for i in range(n_weeks)] for k, v in dc_bl_tmp.items()}

    weekly = {}
    for sku in skus:
        store_block = {}
        for st in stores:
            fl = flags(sku, [st])
            store_block[st] = {
                "sales": sales[(sku, st)], "orders": st_orders.get((sku, st), zeros()),
                "deliveries": st_deliv.get((sku, st), zeros()),
                "inventory": st_inv.get((sku, st), zeros()), **fl}
        dc_block = {}
        for dc in dc_names:
            ss = dcs[dc]
            fl = flags(sku, ss)
            dc_block[dc] = {
                "storeSales": sum_series(sales, sku, ss),
                "storeOrders": sum_series(st_orders, sku, ss),
                "dcOrders": dc_orders.get((sku, dc), zeros()),
                "dcDeliveries": dc_deliv.get((sku, dc), zeros()),
                "dcDeliveriesPromised": dc_deliv_promised.get((sku, dc), zeros()),
                "inventory": dc_inv.get((sku, dc), zeros()),
                "backlog": dc_bl.get((sku, dc), zeros()),
                "delayedWeeks": sorted(delayed_weeks.get((sku, dc), ())), **fl}
        all_st = list(stores)
        fl = flags(sku, all_st)
        weekly[sku] = {
            "store": store_block, "dc": dc_block,
            "network": {
                "storeSales": sum_series(sales, sku, all_st),
                "storeOrders": sum_series(st_orders, sku, all_st),
                "dcOrders": [sum(dc_orders.get((sku, dc), zeros())[i] for dc in dc_names) for i in range(n_weeks)],
                "dcDeliveries": [sum(dc_deliv.get((sku, dc), zeros())[i] for dc in dc_names) for i in range(n_weeks)],
                "dcDeliveriesPromised": [sum(dc_deliv_promised.get((sku, dc), zeros())[i] for dc in dc_names) for i in range(n_weeks)],
                "inventory": [sum(dc_inv.get((sku, dc), zeros())[i] for dc in dc_names) for i in range(n_weeks)],
                "backlog": [sum(dc_bl.get((sku, dc), zeros())[i] for dc in dc_names) for i in range(n_weeks)],
                "delayedWeeks": sorted(set().union(*[delayed_weeks.get((sku, dc), set()) for dc in dc_names])),
                **fl}}

    # ---- 历史回放（情景模拟）：仅读取观察到的周需求，输出独立模拟序列 ----
    scenarios = {}
    for sku in skus:
        scenarios[sku] = {}
        for scope, store_list in [("ALL", list(stores))] + [(dc, dcs[dc]) for dc in dc_names]:
            demand = sum_series(sales, sku, store_list)  # 观察销量（截断周在页面标记）
            scenarios[sku][scope] = {}
            for R in SCENARIO_R:
                for L in SCENARIO_L:
                    scenarios[sku][scope][f"R{R}-L{L}"] = simulate(
                        demand, R, L, pack[sku],
                        products[sku]["dc_moq_cases"], products[sku]["dc_mult_cases"])

    dataset = {
        "meta": {
            "generated": str(date.today()), "grain": "week", "unit": "件",
            "weeks": weeks, "censorShare": CENSOR_SHARE,
            "products": [{"id": sku, "name": products[sku]["name"], "pack": pack[sku],
                          "dcMoqCases": products[sku]["dc_moq_cases"],
                          "dcMultCases": products[sku]["dc_mult_cases"]} for sku in skus],
            "stores": [{"id": s, "dc": store_dc[s]} for s in stores],
            "dcs": [{"id": d, "stores": dcs[d]} for d in dc_names],
            "delays": meta["delays"], "returnEvents": meta["return_events"],
            "scenarioGrid": {"R": SCENARIO_R, "L": SCENARIO_L},
        },
        "weekly": weekly,
        "scenarios": scenarios,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = json.dumps(dataset, ensure_ascii=False, separators=(",", ":"))
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(payload)
    # 页面直接引用的 JS 版本（file:// 打开也能用，无需本地服务）
    with open(OUT.replace(".json", ".js"), "w", encoding="utf-8") as f:
        f.write("window.DATASET = " + payload + ";\n")
    print(f"数据集已生成 -> {OUT} ({os.path.getsize(OUT)//1024} KB)")


def simulate(demand, review_weeks, lead_weeks, pack, moq_cases, mult_cases):
    """周粒度 (R, L) 复盘 + 订货点法历史回放。输入为观察周需求（件），输出模拟序列。"""
    n = len(demand)
    batch = pack * mult_cases
    moq = pack * moq_cases
    inv = int(sum(demand[:2]) * 1.2)  # 初始库存约 2 周需求
    in_transit = defaultdict(int)     # 到货周 -> 件
    orders, inv_eoh, lost = [0] * n, [0] * n, [0] * n
    hist = []
    for w in range(n):
        inv += in_transit.pop(w, 0)
        fill = min(demand[w], inv)
        inv -= fill
        lost[w] = demand[w] - fill
        hist.append(demand[w])
        if w % review_weeks == 0:
            win = hist[-FORECAST_WIN:]
            fc = sum(win) / len(win)
            pos = inv + sum(in_transit.values())
            target = fc * (review_weeks + lead_weeks + SAFETY_WEEKS)
            need = target - pos
            if need > 0:
                qty = max(moq, math.ceil(need / batch) * batch)
                arr = w + lead_weeks
                if arr < n:
                    in_transit[arr] += qty
                orders[w] = qty
        inv_eoh[w] = inv
    total_dem = sum(demand)
    return {"orders": orders, "inventory": inv_eoh, "lost": lost,
            "fillRate": round(1 - sum(lost) / total_dem, 4) if total_dem > 0 else None}


if __name__ == "__main__":
    main()
