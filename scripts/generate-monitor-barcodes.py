#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate-monitor-barcodes.py - 从主 Excel 自动生成所有监控清单 JSON

用法:
  python generate-monitor-barcodes.py

输出:
  scripts/monitor-barcodes-{brand}.json  (成山/兴勤/淘小胖三品牌)
"""
import json
import os
import openpyxl
from pathlib import Path
from collections import Counter

SCRIPT_DIR = Path(__file__).parent
EXCEL_PATH = Path(r'D:\【0】时空品类规划\FY27深度运营门店\当日出勤监控\出勤监控维护维表.xlsx')

# 品牌 → 门店 ID 映射
BRAND_STORES = {
    'csnc': {'1262004557', '1265426893', '1332074728', '541750676', '541968633', '542422914'},
    'txplh': {'1284510785'},
    'xq': {'1137486501', '1328460101'},
}


def read_excel():
    wb = openpyxl.load_workbook(EXCEL_PATH, read_only=True, data_only=True)
    ws = wb.active
    all_recs = {}
    cnt = Counter()

    for row in ws.iter_rows(min_row=2, values_only=True):
        sid = str(row[0]).strip() if row[0] else None
        if not sid:
            continue
        barcode = str(row[3]).strip() if row[3] else ''
        if not barcode:
            continue

        cnt[sid] += 1
        rec = {
            'barcode': barcode,
            'item_id': str(row[1]).strip() if row[1] else '',
            'item_name': str(row[4]).strip() if row[4] else '',
            'store_id': sid,
            'store_name': str(row[2]).strip() if row[2] else '',
            'brand': str(row[6]).strip() if row[6] else '',
            'xiaoer': str(row[5]).strip() if row[5] else '',
            'priority': 'P1',
        }

        if sid not in all_recs:
            all_recs[sid] = []
        all_recs[sid].append(rec)

    wb.close()
    return all_recs, cnt


def generate_json_files(all_recs):
    for brand, store_ids in BRAND_STORES.items():
        recs = []
        for sid in sorted(store_ids):
            recs.extend(all_recs.get(sid, []))

        out_path = SCRIPT_DIR / f'monitor-barcodes-{brand}.json'

        old_count = 0
        if out_path.exists():
            with open(out_path, 'r', encoding='utf-8') as f:
                old_count = len(json.load(f))

        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(recs, f, ensure_ascii=False, indent=2)

        diff = len(recs) - old_count
        diff_str = f'+{diff}' if diff > 0 else f'{diff}' if diff < 0 else '无变化'
        print(f'✓ {brand}: {old_count} → {len(recs)} ({diff_str})')


def main():
    print(f'读取 Excel: {EXCEL_PATH}')
    if not EXCEL_PATH.exists():
        print(f'错误: Excel 文件不存在 {EXCEL_PATH}')
        return

    all_recs, cnt = read_excel()

    print(f'\nExcel 各门店行数:')
    for sid in sorted(cnt.keys()):
        print(f'  {sid}: {cnt[sid]}')

    print(f'\n生成 JSON 文件:')
    generate_json_files(all_recs)
    print('\n完成!')


if __name__ == '__main__':
    main()
