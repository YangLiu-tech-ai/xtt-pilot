#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate-monitor-barcodes.py - 从主 Excel 自动生成所有监控清单 JSON

用法:
  python -X utf8 generate-monitor-barcodes.py [--dry-run]

从 Excel 的"品牌"列自动识别品牌归属，无需手动维护门店 ID 映射。
新增门店只需在 Excel 里加行，脚本会自动归入对应品牌 JSON。

输出:
  scripts/monitor-barcodes-{brand}.json  (成山/兴勤/淘小胖三品牌)
"""
import json
import sys
import io
import argparse
import openpyxl
from pathlib import Path
from collections import Counter, defaultdict

# Windows 终端 GBK 兼容
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

SCRIPT_DIR = Path(__file__).parent
EXCEL_PATH = Path(r'D:\【0】时空品类规划\FY27深度运营门店\当日出勤监控\出勤监控维护维表.xlsx')
BRANDS_CONFIG_PATH = SCRIPT_DIR / 'brands-config.json'

# Excel "品牌"列的值 → monitor-barcodes-{key}.json 的 key
BRAND_NAME_TO_KEY = {
    '成山农场': 'csnc',
    '成山': 'csnc',
    '淘小胖': 'txplh',
    '淘小胖超市': 'txplh',
    '淘小胖鲜品馆': 'txplh',
    '兴勤': 'xq',
    '兴勤超市': 'xq',
}


# 暂不监控的门店（维表中有但不生成到JSON）
SKIP_STORES = set()


def read_excel():
    """读取 Excel，按 Excel 品牌列自动分组到品牌 key"""
    wb = openpyxl.load_workbook(EXCEL_PATH, read_only=True, data_only=True)
    ws = wb.active
    brand_records = defaultdict(list)  # brand_key -> [rec, ...]
    store_info = {}                     # store_id -> {name, brand_key}
    store_cnt = Counter()               # store_id -> row count

    for row in ws.iter_rows(min_row=2, values_only=True):
        sid = str(row[0]).strip() if row[0] else None
        if not sid:
            continue
        if sid in SKIP_STORES:
            continue
        barcode = str(row[3]).strip() if row[3] else ''
        if not barcode:
            continue

        brand_name = str(row[6]).strip() if row[6] else ''
        brand_key = BRAND_NAME_TO_KEY.get(brand_name)

        store_cnt[sid] += 1
        rec = {
            'barcode': barcode,
            'item_id': str(row[1]).strip() if row[1] else '',
            'item_name': str(row[4]).strip() if row[4] else '',
            'store_id': sid,
            'store_name': str(row[2]).strip() if row[2] else '',
            'brand': brand_name,
            'xiaoer': str(row[5]).strip() if row[5] else '',
            'priority': 'P1',
        }

        if brand_key:
            brand_records[brand_key].append(rec)
            store_info[sid] = {
                'name': rec['store_name'],
                'brand_key': brand_key,
            }
        else:
            print(f'  [WARN] 门店 {sid}({rec["store_name"]}) 品牌"{brand_name}"未映射，跳过')

    wb.close()
    return dict(brand_records), store_info, store_cnt


def generate_json_files(brand_records, dry_run=False):
    """生成各品牌的 monitor-barcodes-{brand}.json"""
    for brand_key, recs in sorted(brand_records.items()):
        out_path = SCRIPT_DIR / f'monitor-barcodes-{brand_key}.json'

        old_count = 0
        if out_path.exists():
            with open(out_path, 'r', encoding='utf-8') as f:
                old_count = len(json.load(f))

        if not dry_run:
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump(recs, f, ensure_ascii=False, indent=2)

        diff = len(recs) - old_count
        diff_str = f'+{diff}' if diff > 0 else f'{diff}' if diff < 0 else 'no change'
        prefix = '[DRY-RUN] ' if dry_run else ''
        print(f'  {prefix}{brand_key}: {old_count} -> {len(recs)} ({diff_str})')


def check_brands_config(store_info):
    """检查 brands-config.json 是否包含 Excel 中所有门店"""
    if not BRANDS_CONFIG_PATH.exists():
        return

    with open(BRANDS_CONFIG_PATH, 'r', encoding='utf-8') as f:
        config = json.load(f)

    # 收集 brands-config 中所有 wid
    config_wids = set()
    for brand_data in config.get('brands', {}).values():
        for store in brand_data.get('stores', []):
            config_wids.add(store.get('wid', ''))

    missing = []
    for sid, info in sorted(store_info.items()):
        if sid not in config_wids:
            missing.append((sid, info['name'], info['brand_key']))

    if missing:
        print(f'\n[WARN] {len(missing)} 个门店在 Excel 中存在但 brands-config.json 中缺失:')
        for sid, name, bk in missing:
            print(f'  - {sid} {name} (brand={bk})')
        print('  需要在 brands-config.json 对应品牌下补充 storeId/sellerId')


def main():
    parser = argparse.ArgumentParser(description='从维表 Excel 生成监控清单 JSON')
    parser.add_argument('--dry-run', action='store_true', help='预览变更，不写入文件')
    args = parser.parse_args()

    print(f'Excel: {EXCEL_PATH}')
    if not EXCEL_PATH.exists():
        print(f'[ERROR] Excel not found: {EXCEL_PATH}')
        sys.exit(1)

    brand_records, store_info, store_cnt = read_excel()

    # 按品牌汇总
    print(f'\nExcel stores by brand:')
    brand_stores = defaultdict(set)
    for sid, info in store_info.items():
        brand_stores[info['brand_key']].add(sid)
    for bk in sorted(brand_stores):
        stores = sorted(brand_stores[bk])
        total = sum(store_cnt[s] for s in stores)
        names = ', '.join(f'{s}({store_info[s]["name"]})' for s in stores)
        print(f'  {bk}: {len(stores)} stores, {total} SKUs -> [{names}]')

    # 生成 JSON
    print(f'\n{"[DRY-RUN] " if args.dry_run else ""}Generating JSON:')
    generate_json_files(brand_records, dry_run=args.dry_run)

    # 检查 brands-config 同步
    if not args.dry_run:
        check_brands_config(store_info)

    print('\nDone!')


if __name__ == '__main__':
    main()
