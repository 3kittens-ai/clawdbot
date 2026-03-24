import pandas as pd
import sqlite3
import numpy as np
import os
from forecasting.config import DB_PATH

def filter_incomplete_months(df):
    """根据原始事务数据边界，自动剔除首尾不完整的月份。"""
    conn = sqlite3.connect(DB_PATH)
    # 获取原始数据的绝对时间边界 (从 sales 表直接查)
    try:
        bounds = pd.read_sql("SELECT MIN(sale_date) as min_d, MAX(sale_date) as max_d FROM sales", conn)
    except Exception as e:
        print(f"无法从 sales 表获取边界: {e}")
        conn.close()
        return df
    conn.close()
    
    if bounds['min_d'].iloc[0] is None:
        return df
        
    min_raw = pd.to_datetime(bounds['min_d'].iloc[0])
    max_raw = pd.to_datetime(bounds['max_d'].iloc[0])
    
    # 获取所属月份的月初和月末
    min_month_start = min_raw.replace(day=1)
    max_month_end = (max_raw + pd.offsets.MonthEnd(0)).normalize()
    
    invalid_months = []
    # 如果第一条记录不是 1 号，剔除该月
    if min_raw > min_month_start:
        invalid_months.append(min_raw.strftime('%Y-%m'))
    # 如果最后一条记录不是月末最后一天，剔除该月
    if max_raw < max_month_end:
        invalid_months.append(max_raw.strftime('%Y-%m'))
    
    if invalid_months:
        print(f"检测到不完整月份 (数据源非月度边界)，已剔除: {invalid_months}")
        df = df[~df['year_month'].isin(invalid_months)].copy()
    
    return df

def load_sku_monthly_data():
    """从视图中加载 SKU 月度销售数据，并自动过滤不完整月份。"""
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT * FROM v_training_base"
    df = pd.read_sql(query, conn)
    conn.close()
    
    # 自动过滤不完整月份
    df = filter_incomplete_months(df)
    
    # 将 year_month 转换为 datetime 格式
    df['date'] = pd.to_datetime(df['year_month'] + '-01')
    return df

def fill_missing_months(df):
    """在每个 Variant 的生命周期内，将缺失月份填充为零。"""
    # 整个数据集的全局最大日期
    global_max_date = df['date'].max()
    
    # 计算每个 Variant 首次出现的月份
    variant_first_date = df.groupby('variant_key')['date'].min().reset_index()
    
    variant_templates = []
    for _, row in variant_first_date.iterrows():
        variant = row['variant_key']
        start_date = row['date']
        # 从首次出现到数据集结束进行填充
        variant_months = pd.date_range(start=start_date, end=global_max_date, freq='MS')
        variant_templates.append(pd.DataFrame({'date': variant_months, 'variant_key': variant}))
    
    template = pd.concat(variant_templates, ignore_index=True)
    
    # 与实际数据合并
    df_filled = pd.merge(template, df, on=['date', 'variant_key'], how='left')
    
    # 将缺失销量和数值字段填充为 0
    df_filled['monthly_qty'] = df_filled['monthly_qty'].fillna(0)
    df_filled['total_paid_amount'] = df_filled['total_paid_amount'].fillna(0)
    df_filled['max_active_stores'] = df_filled['max_active_stores'].fillna(0)
    
    # 提前计算实售折算率 (防止递归预测时出现 1.0 导致的向上漂移)
    df_filled['discount_ratio'] = df_filled['total_paid_amount'] / (df_filled['monthly_qty'] * df_filled['avg_tag_price']).replace(0, np.nan)
    df_filled['discount_ratio'] = df_filled['discount_ratio'].fillna(1.0).clip(0.2, 1.2)
    
    # 静态属性双向填充；月度价格 (和折算率) 只能向前填充
    static_cols = [
        'family_tags', 'product_category', 'spec_length', 'spec_size', 'spec_hook', 'spec_qty', 'main_channel', 'top_province'
    ]
    price_cols = ['avg_base_price', 'avg_tag_price', 'discount_ratio']
    df_filled = df_filled.sort_values(['variant_key', 'date'])
    df_filled[static_cols] = df_filled.groupby('variant_key', observed=True)[static_cols].ffill().bfill()
    df_filled[price_cols] = df_filled.groupby('variant_key', observed=True)[price_cols].ffill()
    
    # 加回 year_month 字段
    df_filled['year_month'] = df_filled['date'].dt.strftime('%Y-%m')
    
    return df_filled

if __name__ == '__main__':
    # Add project root to path if needed
    import sys
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    
    print("正在加载数据...")
    df = load_sku_monthly_data()
    print(f"已加载 {len(df)} 条记录。")
    
    print("正在填充缺失月份...")
    df_filled = fill_missing_months(df)
    print(f"填充后总记录数: {len(df_filled)}")
    
    # 简单检查
    print(df_filled.head())
