import pandas as pd
import numpy as np
from forecasting.config import CNY_DATES, MID_AUTUMN_DATES, DRAGON_BOAT_DATES, PROMO_MONTHS

def add_time_features(df: pd.DataFrame) -> pd.DataFrame:
    """添加时间特征：月、季、春节/中秋/端午偏移等。"""
    df = df.copy()
    df['month'] = df['date'].dt.month
    df['year'] = df['date'].dt.year
    df['quarter'] = df['date'].dt.quarter
    
    # 是否是国庆月
    df['is_national_day_month'] = (df['month'] == 10).astype(int)
    
    # 距离假日/节气的月数偏移
    def get_holiday_offset(date, holiday_dict):
        year = date.year
        if year in holiday_dict:
            target_date = pd.to_datetime(holiday_dict[year])
            return (date.year - target_date.year) * 12 + (date.month - target_date.month)
        return 0
    
    df['cny_offset'] = df['date'].apply(lambda x: get_holiday_offset(x, CNY_DATES))
    df['mid_autumn_offset'] = df['date'].apply(lambda x: get_holiday_offset(x, MID_AUTUMN_DATES))
    df['dragon_boat_offset'] = df['date'].apply(lambda x: get_holiday_offset(x, DRAGON_BOAT_DATES))
    
    # 是否是大促月
    df['is_promo_month'] = df['month'].isin(PROMO_MONTHS).astype(int)
    
    return df

def add_lag_features(df: pd.DataFrame) -> pd.DataFrame:
    """添加销量滞后特征。"""
    df = df.sort_values(['variant_key', 'date'])
    for lag in [1, 2, 3, 6, 12]:
        df[f'lag_{lag}'] = df.groupby('variant_key', observed=True)['monthly_qty'].shift(lag)
    return df

def add_rolling_features(df: pd.DataFrame) -> pd.DataFrame:
    """添加滚动窗口特征 (不包含当前月)。"""
    df = df.sort_values(['variant_key', 'date'])
    for window in [3, 6, 12]:
        df[f'rolling_mean_{window}'] = df.groupby('variant_key', observed=True)['monthly_qty'].transform(
            lambda x: x.shift(1).rolling(window, min_periods=1).mean()
        )
    return df

def add_family_features(df: pd.DataFrame, anchor_cutoff: str = None) -> pd.DataFrame:
    """添加 Family 级别的聚合特征 (确保时序对齐)。"""
    # 彻底解决递归预测时的列名冲突
    cols_to_drop = ['family_lag_1', 'family_rolling_6']
    df = df.drop(columns=cols_to_drop, errors='ignore')

    # 1. 显式计算家族月度销量序列
    family_stats = df.groupby(['family_tags', 'date'])['monthly_qty'].sum().reset_index()
    family_stats = family_stats.sort_values(['family_tags', 'date'])
    
    # 2. 在家族级别计算滞后和滚动
    family_stats['family_lag_1'] = family_stats.groupby('family_tags', observed=True)['monthly_qty'].shift(1)
    family_stats['family_rolling_6'] = family_stats.groupby('family_tags', observed=True)['monthly_qty'].transform(
        lambda x: x.shift(1).rolling(6, min_periods=1).mean()
    )
    
    # 3. 添加季节性锚点 (该变体在该月份的历史平均销量)
    # 如果数据框中已经存在 seasonal_anchor (例如由 predict_recursive 预注入)，则跳过重算。
    # 这确保了递归预测过程中锚点口径与训练时完全一致，避免因窗口截断导致的 skew。
    if 'seasonal_anchor' not in df.columns:
        df['month_val'] = df['date'].dt.month
        
        # 允许外部传入 cutoff (回测必须传入以防泄漏)
        if anchor_cutoff is None:
            # 默认使用数据集中最后一个月的下一个月作为 cutoff
            # 这样所有现有数据都被视为历史，用于计算锚点
            anchor_cutoff = (df['date'].max() + pd.DateOffset(months=1)).strftime('%Y-%m')
                 
        # A. 变体级锚点 (用于保持 SKU 个性)
        variant_seasonal = df[df['date'] < anchor_cutoff].groupby(['variant_key', 'month_val'], observed=True)['monthly_qty'].mean().reset_index()
        variant_seasonal.rename(columns={'monthly_qty': 'seasonal_anchor'}, inplace=True)
        
        # B. 家族级锚点 (用于新 SKU 兜底)
        family_seasonal = df[df['date'] < anchor_cutoff].groupby(['family_tags', 'month_val'], observed=True)['monthly_qty'].mean().reset_index()
        family_seasonal.rename(columns={'monthly_qty': 'family_seasonal_anchor'}, inplace=True)
        
        df = df.merge(variant_seasonal, on=['variant_key', 'month_val'], how='left')
        df = df.merge(family_seasonal, on=['family_tags', 'month_val'], how='left')
        
        # 兜底：如果变体级锚点缺失，使用家族级；最后填 0
        df['seasonal_anchor'] = df['seasonal_anchor'].fillna(df['family_seasonal_anchor'])
        df['seasonal_anchor'] = df['seasonal_anchor'].fillna(0)
        df.drop(columns=['family_seasonal_anchor', 'month_val'], inplace=True, errors='ignore')

    # 4. 合并实时家族特征 (滞后/滚动) - 即使锚点静态，这些也是动态计算的
    df = df.merge(
        family_stats[['family_tags', 'date', 'family_lag_1', 'family_rolling_6']], 
        on=['family_tags', 'date'], 
        how='left'
    )
    
    return df

def build_features(df: pd.DataFrame, anchor_cutoff: str = None, mode: str = 'tail') -> pd.DataFrame:
    """构建所有特征。根据 mode 差异化增加特征。"""
    df = df.copy()
    df = add_time_features(df)
    df = add_lag_features(df)
    df = add_rolling_features(df)
    
    # 季节性锚点 (保持 V4.9 逻辑)
    df = add_family_features(df, anchor_cutoff=anchor_cutoff)
    
    if mode == 'top':
        # 针对 Top SKU: 增加动量特征 (Momentum)，让模型对其近期趋势极度敏感
        # 1. 最近 1 个月 vs 过去 3 个月均值
        df['momentum_1_3'] = df['lag_1'] / df['rolling_mean_3'].replace(0, np.nan)
        df['momentum_1_3'] = df['momentum_1_3'].fillna(1.0).clip(0, 5)
        # 2. 最近 3 个月 vs 过去 6 个月均值
        df['momentum_3_6'] = df['rolling_mean_3'] / df['rolling_mean_6'].replace(0, np.nan)
        df['momentum_3_6'] = df['momentum_3_6'].fillna(1.0).clip(0, 5)
        
    # 折算率修复：使用预加载或默认值 (不再按量动态计算，防止递归漂移)
    if 'discount_ratio' not in df.columns:
        df['discount_ratio'] = 1.0
    
    # 分类变量编码
    cat_cols = [
        'family_tags', 'variant_key', 'product_category', 
        'spec_length', 'spec_size', 'spec_hook', 'spec_qty', 'month', 'main_channel', 'top_province'
    ]
    for col in cat_cols:
        if col in df.columns:
            df[col] = df[col].astype('category')
        
    return df
