import glob
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import pandas as pd

# 1. 路径设置
MODEL_ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = MODEL_ROOT / "outputs" / "forecast_results.csv"
DB_PATH = MODEL_ROOT / "data-base" / "sales_filtered.sqlite"
OUTPUT_DIR = MODEL_ROOT / "outputs" / "final"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 清理旧文件
for old_file in glob.glob(str(OUTPUT_DIR / "results-*.xlsx")):
    try:
        os.remove(old_file)
        print(f"已清理旧预测文件: {os.path.basename(old_file)}")
    except:
        pass

# 生成时间戳文件名
now = datetime.now().strftime('%Y%m%d-%H%M%S')
NEW_EXCEL_FILENAME = f'results-{now}-forecast-export-{now}.xlsx'
NEW_EXCEL_PATH = OUTPUT_DIR / NEW_EXCEL_FILENAME

print(f"解析预测数据: {CSV_PATH}...")
forecast_df = pd.read_csv(CSV_PATH)
# 强制 SKU 为字符串，防止科学计数法
forecast_df['variant_key'] = forecast_df['variant_key'].astype(str)

# 2. 从数据库获取 SKU 元数据
print("从数据库加载 SKU 维表信息...")
conn = sqlite3.connect(DB_PATH)
# 增加 family_tags 字段用于分组汇总
query = "SELECT sku_code as variant_key, sku_name, product_category, family_tags FROM dim_sku"
dim_sku = pd.read_sql(query, conn)
conn.close()
dim_sku['variant_key'] = dim_sku['variant_key'].astype(str)

# 3. 透视预测结果 (SKU 为行，月份为列)
print("转换数据格式 (Pivot)...")
pivot_df = forecast_df.pivot(index='variant_key', columns='year_month', values='forecast_qty').reset_index()

# 4. 合并元数据
print("合并 SKU 信息内容...")
merged_df = pd.merge(dim_sku, pivot_df, on='variant_key', how='right')

# 5. 计算 12 个月汇总销量
print("计算 12 个月汇总销量...")
month_cols = pivot_df.columns.drop('variant_key').tolist()
merged_df['12个月汇总销量'] = merged_df[month_cols].sum(axis=1)

# 5. 生成 Product Root (关键词匹配到的所有 tag 组合)
from forecasting.utils.tag_extractor import load_keywords, extract_tags_from_name
TAGS_FILE = MODEL_ROOT / "docs" / "tags.md"
keyword_list = load_keywords(TAGS_FILE)

def get_tag_root(row):
    cat = str(row['product_category'])
    tags = extract_tags_from_name(row['sku_name'], keyword_list)
    # 组合 Category + Tags，并去重保持顺序
    all_elements = [cat]
    for t in tags:
        if t != cat:
            all_elements.append(t)
    return "|".join(all_elements)

print("逻辑更新：将【产品分类】前置于 Product Root 汇总...")
merged_df['product_root'] = merged_df.apply(get_tag_root, axis=1)

# 按 Product Root 汇总
product_groups = merged_df.groupby('product_root')
final_rows = []

# 按 Product 汇总销量降序遍历
product_totals = product_groups['12个月汇总销量'].sum().sort_values(ascending=False)

for prod, _ in product_totals.items():
    group = merged_df[merged_df['product_root'] == prod].sort_values('12个月汇总销量', ascending=False)
    
    # 添加 Product 汇总行 (放在该组最上方)
    summary_row = {
        'variant_key': f'Product TOTAL',
        'sku_name': f'【汇总】{prod}',
        'product_category': group['product_category'].iloc[0] if not group.empty else '',
        'family_tags': group['family_tags'].iloc[0] if not group.empty else '',
        '12个月汇总销量': group['12个月汇总销量'].sum()
    }
    for col in month_cols:
        summary_row[col] = group[col].sum()
    
    final_rows.append(pd.DataFrame([summary_row]))
    final_rows.append(group)

final_df = pd.concat(final_rows, ignore_index=True)

# 7. 重构列序：元数据 -> 汇总 -> 各月
id_cols = ['商品编码', '商品名称', '产品分类']
final_df = final_df.rename(columns={'variant_key': '商品编码', 'sku_name': '商品名称', 'product_category': '产品分类'})
ordered_cols = id_cols + ['12个月汇总销量'] + month_cols
final_df = final_df[ordered_cols]

print(f"正在以专业格式保存至 Excel: {NEW_EXCEL_PATH}...")
with pd.ExcelWriter(NEW_EXCEL_PATH, engine='openpyxl') as writer:
    final_df.to_excel(writer, index=False, sheet_name='Sales Forecast')
    
    # 获取 worksheet 对象进行样式调整
    workbook = writer.book
    worksheet = writer.sheets['Sales Forecast']
    from openpyxl.styles import Font, PatternFill, Alignment
    
    # 1. 设置列宽
    column_widths = {
        '商品编码': 16,
        '商品名称': 45,
        '产品分类': 15,
        '12个月汇总销量': 18
    }
    # 其他列 (月份) 统一为 12
    for i, col in enumerate(final_df.columns):
        width = column_widths.get(col, 12)
        # 将索引转换为 Excel 列字母 (A, B, C...)
        col_letter = chr(65 + i) if i < 26 else chr(65 + i // 26 - 1) + chr(65 + i % 26)
        worksheet.column_dimensions[col_letter].width = width
    
    # 2. 设置行高和汇总行样式
    header_fill = PatternFill(start_color='D7E4BC', end_color='D7E4BC', fill_type='solid')
    summary_fill = PatternFill(start_color='FDE9D9', end_color='FDE9D9', fill_type='solid')
    bold_font = Font(bold=True)
    center_align = Alignment(horizontal='center', vertical='center')
    
    # 设置表头样式
    for cell in worksheet[1]:
        cell.font = bold_font
        cell.fill = header_fill
        cell.alignment = center_align
    
    # 遍历行设置行高和汇总行背景
    for row_idx, row in enumerate(worksheet.iter_rows(min_row=2), start=2):
        worksheet.row_dimensions[row_idx].height = 20
        
        # 如果是汇总行 (商品名称包含“【汇总】”)
        sku_name_val = worksheet.cell(row=row_idx, column=2).value
        if sku_name_val and '【汇总】' in str(sku_name_val):
            for cell in row:
                cell.font = bold_font
                cell.fill = summary_fill

print("=== 导出完成 (含样式) ===")
print(f"FILE_PATH:{NEW_EXCEL_PATH}")
