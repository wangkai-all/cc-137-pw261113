#!/usr/bin/env python3
"""生成牛鞭效应观察台的本地样本数据（确定性，stdlib only）。

网络：1 个供应商 -> 2 个配送中心(DC) -> 各 3 家门店，3 个商品。
时间：2026-05-18(周一) ~ 2026-11-15(周日)，共 26 周、182 天，日粒度。

样本特意包含：批量订货(MOQ/整箱取整)、促销、延迟交付、门店缺货、退货。
输出 CSV 到 data/sample/。所有随机流使用固定种子，结果可复现。
"""
import csv
import json
import math
import os
import random
from datetime import date, timedelta

SEED = 20261114
START = date(2026, 5, 18)   # 周一
WEEKS = 26
DAYS = WEEKS * 7

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "sample")

PRODUCTS = {
    "SKU-1001": {"name": "纯牛奶 1L", "pack": 12, "base": 38, "weekend": 1.30,
                 "store_cover": 4.5, "dc_moq": 20, "dc_mult": 10},
    "SKU-2002": {"name": "洗衣液 2kg", "pack": 6, "base": 10, "weekend": 1.05,
                 "store_cover": 7.0, "dc_moq": 60, "dc_mult": 20},
    "SKU-3003": {"name": "美式咖啡 250ml", "pack": 24, "base": 52, "weekend": 1.20,
                 "store_cover": 5.0, "dc_moq": 20, "dc_mult": 10},
}
STORES = ["S01", "S02", "S03", "S04", "S05", "S06"]
DCS = {"DC-N": ["S01", "S02", "S03"], "DC-S": ["S04", "S05", "S06"]}
STORE_DC = {s: d for d, ss in DCS.items() for s in ss}

# 促销：sku -> (起始日, 结束日, 门店集合,  uplift)
PROMOS = [
    {"sku": "SKU-1001", "start": START + timedelta(days=8 * 7), "end": START + timedelta(days=9 * 7 + 6),
     "stores": sorted(STORES), "uplift": 1.7, "label": "牛奶全场促销"},
    {"sku": "SKU-3003", "start": START + timedelta(days=16 * 7), "end": START + timedelta(days=17 * 7 + 6),
     "stores": DCS["DC-S"], "uplift": 1.5, "label": "咖啡南区促销"},
]

# 延迟交付：(dc, sku, 承诺到货周序号) -> 延迟天数
DELAYS = {("DC-N", "SKU-1001", 12): 7, ("DC-S", "SKU-3003", 18): 7,
          ("DC-N", "SKU-2002", 21): 7, ("DC-S", "SKU-1001", 6): 7}

# 门店 -> DC 的集中退货事件（破损）：(日期, 门店, sku, 件数)
RETURN_EVENTS = [(START + timedelta(days=15 * 7 + 2), "S02", "SKU-2002", 60)]


def daterange():
    for i in range(DAYS):
        yield START + timedelta(days=i)


def week_idx(d):
    return (d - START).days // 7


def main():
    rng = random.Random(SEED)
    os.makedirs(OUT, exist_ok=True)

    # ---- 门店需求系数（门店平均速率 = base × store_factor，门店订货策略据此估计） ----
    store_factor = {}
    for sku in PRODUCTS:
        for s in STORES:
            store_factor[(s, sku)] = 0.8 + 0.1 * STORES.index(s) + rng.uniform(-0.05, 0.05)

    # ---- 潜在日需求（生成器真值，页面不使用，仅供校验） ----
    latent = {}   # (date, store, sku) -> qty
    for sku, p in PRODUCTS.items():
        for s in STORES:
            sf = store_factor[(s, sku)]
            for d in daterange():
                wd = 1.0
                if d.weekday() == 5:
                    wd = p["weekend"]
                elif d.weekday() == 6:
                    wd = 1.0 + (p["weekend"] - 1.0) * 0.6
                uplift = 1.0
                for pr in PROMOS:
                    if pr["sku"] == sku and s in pr["stores"] and pr["start"] <= d <= pr["end"]:
                        uplift = pr["uplift"]
                noise = max(0.15, rng.gauss(1.0, 0.12))
                latent[(d, s, sku)] = max(0, round(p["base"] * sf * wd * uplift * noise))

    # ---- 门店层日仿真：收货 -> 销售(缺货截断) -> 订货 ----
    sales, stockouts, store_inv = {}, {}, {}
    store_orders, store_deliveries, returns = [], [], []
    on_hand = {(s, sku): int(p["base"] * p["store_cover"] * 1.2)
               for s in STORES for sku, p in PRODUCTS.items()}
    in_transit = {}  # (arrive_date, store, sku) -> cases
    for d in daterange():
        for s in STORES:
            for sku, p in PRODUCTS.items():
                key = (s, sku)
                on_hand[key] += in_transit.pop((d, s, sku), 0) * p["pack"]
                dem = latent[(d, s, sku)]
                sold = min(dem, on_hand[key])
                lost = dem - sold
                sales[(d, s, sku)] = sold
                if lost > 0:
                    stockouts[(d, s, sku)] = lost
                on_hand[key] -= sold
                # 退货：顾客退货（约为销量的 0~2%）与集中退货事件
                ret = 0
                if rng.random() < 0.25:
                    ret = round(sold * rng.uniform(0.0, 0.02))
                for (rd, rs, rsku, rq) in RETURN_EVENTS:
                    if rd == d and rs == s and rsku == sku:
                        ret += rq
                if ret > 0:
                    returns.append({"date": d, "store": s, "sku": sku, "qty": ret,
                                    "reason": "破损退回DC" if ret >= 20 else "顾客退货"})
                # 订货：周一/周四复盘，(s,S) 策略，整箱；速率用门店自身均值估计
                if d.weekday() in (0, 3):
                    rate = p["base"] * store_factor[(s, sku)]
                    pos = on_hand[key] + sum(c * p["pack"] for (ad, ss, sk), c in in_transit.items()
                                             if ss == s and sk == sku)
                    reorder_pt = rate * 4.5   # 覆盖周四复盘->下周二到货(含周末高峰)
                    target = rate * (p["store_cover"] + 2.0)
                    if pos < reorder_pt:
                        cases = max(1, math.ceil((target - pos) / p["pack"]))
                        store_orders.append({"order_date": d, "store": s, "sku": sku, "cases": cases})
                        arr = d + timedelta(days=1)
                        store_deliveries.append({"date": arr, "store": s, "sku": sku, "cases": cases})
                        in_transit[(arr, s, sku)] = in_transit.get((arr, s, sku), 0) + cases
                store_inv[(d, s, sku)] = on_hand[key]

    # ---- DC 层日仿真：收供应商货 -> 履约门店订单(可积压) -> 周日复盘订货 ----
    dc_orders, dc_deliveries = [], []
    dc_inv, dc_backlog = {}, {}
    dc_on_hand = {(dc, sku): int(p["base"] * 7 * 2.0 * len(dc_stores) / p["pack"]) * p["pack"]
                  for dc, dc_stores in DCS.items() for sku, p in PRODUCTS.items()}  # 约 2 周门店需求(件)
    dc_in_transit = {}   # (arrive_date, dc, sku) -> cases
    backlog = {(dc, sku): [] for dc in DCS for sku in PRODUCTS}  # [(date, store, cases)]
    store_orders_by_day = {}
    for o in store_orders:
        store_orders_by_day.setdefault(o["order_date"], []).append(o)
    recent_store_demand = {(dc, sku): [] for dc in DCS for sku in PRODUCTS}  # 最近4周门店订货(件)

    for d in daterange():
        for dc, dc_stores in DCS.items():
            for sku, p in PRODUCTS.items():
                key = (dc, sku)
                dc_on_hand[key] += dc_in_transit.pop((d, dc, sku), 0) * p["pack"]
                # 今日门店订单进入积压队列（先进先出履约）
                for o in store_orders_by_day.get(d, []):
                    if STORE_DC[o["store"]] == dc and o["sku"] == sku:
                        backlog[key].append([d, o["store"], o["cases"]])
                # 履约：能发则发（次日到店，已在门店层登记在途），发不出则留积压
                remain = []
                for (od, st, cases) in backlog[key]:
                    need = cases * p["pack"]
                    if dc_on_hand[key] >= need:
                        dc_on_hand[key] -= need
                    else:
                        # 部分履约：发整箱可发部分，其余继续积压
                        full = int(dc_on_hand[key] // p["pack"])
                        if full > 0:
                            dc_on_hand[key] -= full * p["pack"]
                            # 调整门店在途：少发的部分留积压
                            arr = od + timedelta(days=1)
                            in_transit[(arr, st, sku)] = in_transit.get((arr, st, sku), 0) - (cases - full)
                            if in_transit[(arr, st, sku)] <= 0:
                                in_transit.pop((arr, st, sku), None)
                            for sd in store_deliveries:
                                if sd["date"] == arr and sd["store"] == st and sd["sku"] == sku:
                                    sd["cases"] = full
                                    break
                            remain.append([od, st, cases - full])
                        else:
                            remain.append([od, st, cases])
                backlog[key] = remain
                # 周日复盘：按最近4周门店订货均值做订货点法，MOQ/整批取整
                if d.weekday() == 6:
                    hist = recent_store_demand[key][-4:]
                    fc = (sum(hist) / len(hist)) if hist else p["base"] * 7 * len(dc_stores)
                    pos = dc_on_hand[key] + sum(c * p["pack"] for (ad, dc2, sk), c in dc_in_transit.items()
                                                if dc2 == dc and sk == sku)
                    backlog_qty = sum(c for _, _, c in backlog[key]) * p["pack"]
                    target = fc * (1 + 1 + 0.3)  # 复盘间隔1周 + 提前期1周 + 安全0.3周
                    need = target - pos - backlog_qty
                    if need > 0:
                        cases = max(p["dc_moq"], math.ceil(need / p["pack"] / p["dc_mult"]) * p["dc_mult"])
                        wk = week_idx(d) + 1  # 承诺到货周（提前期1周）
                        delay = DELAYS.get((dc, sku, wk), 0)
                        promised = d + timedelta(days=7)
                        actual = promised + timedelta(days=delay)
                        dc_orders.append({"order_date": d, "dc": dc, "sku": sku, "cases": cases})
                        dc_deliveries.append({"dc": dc, "sku": sku, "promised_date": promised,
                                              "actual_date": actual, "cases": cases})
                        dc_in_transit[(actual, dc, sku)] = dc_in_transit.get((actual, dc, sku), 0) + cases
                dc_inv[(d, dc, sku)] = dc_on_hand[key]
                dc_backlog[(d, dc, sku)] = sum(c for _, _, c in backlog[key]) * p["pack"]
        # 记录本周门店订货（供 DC 预测）
        if d.weekday() == 6:
            for dc, dc_stores in DCS.items():
                for sku in PRODUCTS:
                    wk_qty = sum(o["cases"] * PRODUCTS[sku]["pack"]
                                 for o in store_orders
                                 if STORE_DC[o["store"]] == dc and o["sku"] == sku
                                 and week_idx(o["order_date"]) == week_idx(d))
                    recent_store_demand[(dc, sku)].append(wk_qty)

    # ---- 写 CSV ----
    def w(name, header, rows):
        with open(os.path.join(OUT, name), "w", newline="", encoding="utf-8") as f:
            wr = csv.writer(f)
            wr.writerow(header)
            wr.writerows(rows)

    w("store_sales_daily.csv", ["date", "store", "sku", "qty"],
      [(d, s, sku, sales[(d, s, sku)]) for d, s, sku in sorted(sales, key=lambda k: (k[0], k[1], k[2]))])
    w("store_demand_latent_daily.csv", ["date", "store", "sku", "qty"],
      [(d, s, sku, q) for (d, s, sku), q in sorted(latent.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2]))])
    w("store_stockouts_daily.csv", ["date", "store", "sku", "lost_qty"],
      [(d, s, sku, q) for (d, s, sku), q in sorted(stockouts.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2]))])
    w("store_inventory_daily.csv", ["date", "store", "sku", "eoh_qty"],
      [(d, s, sku, q) for (d, s, sku), q in sorted(store_inv.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2]))])
    w("store_orders.csv", ["order_date", "store", "sku", "cases"],
      [(o["order_date"], o["store"], o["sku"], o["cases"]) for o in store_orders])
    w("store_deliveries.csv", ["date", "store", "sku", "cases"],
      [(x["date"], x["store"], x["sku"], x["cases"]) for x in store_deliveries])
    w("store_returns_daily.csv", ["date", "store", "sku", "qty", "reason"],
      [(r["date"], r["store"], r["sku"], r["qty"], r["reason"]) for r in returns])
    w("dc_orders.csv", ["order_date", "dc", "sku", "cases"],
      [(o["order_date"], o["dc"], o["sku"], o["cases"]) for o in dc_orders])
    w("dc_deliveries.csv", ["dc", "sku", "promised_date", "actual_date", "cases"],
      [(x["dc"], x["sku"], x["promised_date"], x["actual_date"], x["cases"]) for x in dc_deliveries])
    w("dc_inventory_daily.csv", ["date", "dc", "sku", "eoh_qty", "backlog_qty"],
      [(d, dc, sku, dc_inv[(d, dc, sku)], dc_backlog[(d, dc, sku)])
       for (d, dc, sku) in sorted(dc_inv, key=lambda k: (k[0], k[1], k[2]))])
    w("promotions.csv", ["sku", "store", "start", "end", "uplift", "label"],
      [(pr["sku"], s, pr["start"], pr["end"], pr["uplift"], pr["label"]) for pr in PROMOS for s in pr["stores"]])

    meta = {
        "seed": SEED, "start": str(START), "weeks": WEEKS,
        "products": {k: {"name": v["name"], "pack": v["pack"],
                         "dc_moq_cases": v["dc_moq"], "dc_mult_cases": v["dc_mult"]}
                     for k, v in PRODUCTS.items()},
        "stores": STORES, "dcs": {k: v for k, v in DCS.items()},
        "delays": [{"dc": k[0], "sku": k[1], "promised_week": k[2], "delay_days": v}
                   for k, v in sorted(DELAYS.items())],
        "return_events": [{"date": str(d), "store": s, "sku": sku, "qty": q}
                          for (d, s, sku, q) in RETURN_EVENTS],
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    n_lost = sum(stockouts.values())
    n_lost_days = len(stockouts)
    print(f"样本已生成 -> {OUT}")
    print(f"  门店订单 {len(store_orders)} 行, DC订单 {len(dc_orders)} 行, "
          f"缺货日 {n_lost_days} 个(损失 {n_lost} 件), 退货 {len(returns)} 行, "
          f"延迟交付 {sum(1 for x in dc_deliveries if x['actual_date'] > x['promised_date'])} 单")


if __name__ == "__main__":
    main()
