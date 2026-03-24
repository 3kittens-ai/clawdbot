import lightgbm as lgb
import pandas as pd
import numpy as np
import os
import json
from typing import Optional
from forecasting.config import (
    LGBM_PARAMS,
    FORECAST_HORIZON,
    TOP_SKU_THRESHOLD,
    FOCUS_FAMILY_CALIBRATION_WHITELIST,
    FOCUS_FAMILY_CALIBRATION_WINDOW_MONTHS,
    FOCUS_FAMILY_CALIBRATION_MIN_ACTUAL_SUM,
    FOCUS_FAMILY_CALIBRATION_MIN_ACTIVE_MONTHS,
    FOCUS_FAMILY_CALIBRATION_MIN_ABS_BIAS,
    FOCUS_FAMILY_CALIBRATION_SHRINK_ACTUAL_REF,
    FOCUS_FAMILY_CALIBRATION_SHRINK_MONTH_REF,
    FOCUS_FAMILY_CALIBRATION_PARENT_DECAY,
    FOCUS_FAMILY_CALIBRATION_SCOPE_OVERRIDES,
    FOCUS_FAMILY_CALIBRATION_DIRECTION,
    FAMILY_CALIBRATION_WINDOW_MONTHS,
    FAMILY_CALIBRATION_MAX_FAMILIES,
    FAMILY_CALIBRATION_MIN_ACTUAL_SUM,
    FAMILY_CALIBRATION_MIN_ABS_BIAS,
    FAMILY_CALIBRATION_MIN_SCALE,
    FAMILY_CALIBRATION_MAX_SCALE,
    FAMILY_CALIBRATION_PRIORITY_FAMILIES,
)
from forecasting.features import build_features, add_time_features
import copy

FUTURE_UNKNOWN_PRICE_COLS = ['avg_base_price', 'avg_tag_price', 'discount_ratio']


def _build_cross_sectional_anchor_tables(anchor_src: pd.DataFrame):
    anchor_src = anchor_src.copy()
    anchor_src['month_val'] = anchor_src['date'].dt.month

    family = anchor_src.groupby(['family_tags', 'month_val'], observed=True)['monthly_qty'].mean().reset_index()
    family.rename(columns={'monthly_qty': 'family_seasonal_anchor'}, inplace=True)

    category = anchor_src.groupby(['product_category', 'month_val'], observed=True)['monthly_qty'].mean().reset_index()
    category.rename(columns={'monthly_qty': 'category_seasonal_anchor'}, inplace=True)

    channel_category = anchor_src.groupby(['main_channel', 'product_category', 'month_val'], observed=True)['monthly_qty'].mean().reset_index()
    channel_category.rename(columns={'monthly_qty': 'channel_category_seasonal_anchor'}, inplace=True)

    global_month = anchor_src.groupby(['month_val'], observed=True)['monthly_qty'].mean().reset_index()
    global_month.rename(columns={'monthly_qty': 'global_month_seasonal_anchor'}, inplace=True)

    return family, category, channel_category, global_month


def _apply_cross_sectional_anchor(df: pd.DataFrame, family, category, channel_category, global_month) -> pd.DataFrame:
    df = df.copy()
    df['month_val'] = df['date'].dt.month
    df = df.merge(family, on=['family_tags', 'month_val'], how='left')
    df = df.merge(category, on=['product_category', 'month_val'], how='left')
    df = df.merge(channel_category, on=['main_channel', 'product_category', 'month_val'], how='left')
    df = df.merge(global_month, on=['month_val'], how='left')
    df['cold_start_anchor'] = df['family_seasonal_anchor']
    df['cold_start_anchor'] = df['cold_start_anchor'].fillna(df['channel_category_seasonal_anchor'])
    df['cold_start_anchor'] = df['cold_start_anchor'].fillna(df['category_seasonal_anchor'])
    df['cold_start_anchor'] = df['cold_start_anchor'].fillna(df['global_month_seasonal_anchor'])
    df['cold_start_anchor'] = df['cold_start_anchor'].fillna(0)
    return df.drop(
        columns=[
            'month_val',
            'family_seasonal_anchor',
            'category_seasonal_anchor',
            'channel_category_seasonal_anchor',
            'global_month_seasonal_anchor',
        ],
        errors='ignore',
    )


def _build_price_reference(history_df: pd.DataFrame):
    channel_category = history_df.groupby(['main_channel', 'product_category'], observed=True)[FUTURE_UNKNOWN_PRICE_COLS].median().reset_index()
    category = history_df.groupby(['product_category'], observed=True)[FUTURE_UNKNOWN_PRICE_COLS].median().reset_index()
    global_prices = history_df[FUTURE_UNKNOWN_PRICE_COLS].median()
    return channel_category, category, global_prices


def _fill_price_features(df: pd.DataFrame, history_df: pd.DataFrame, exogenous_df: pd.DataFrame = None) -> pd.DataFrame:
    df = df.copy()
    channel_category_prices, category_prices, global_prices = _build_price_reference(history_df)
    df = df.merge(channel_category_prices, on=['main_channel', 'product_category'], how='left', suffixes=('', '_cc'))
    df = df.merge(category_prices, on=['product_category'], how='left', suffixes=('', '_cat'))

    if exogenous_df is not None and not exogenous_df.empty:
        available_cols = ['variant_key', 'date'] + [c for c in FUTURE_UNKNOWN_PRICE_COLS if c in exogenous_df.columns]
        df = df.merge(exogenous_df[available_cols], on=['variant_key', 'date'], how='left', suffixes=('', '_exog'))

    for col in FUTURE_UNKNOWN_PRICE_COLS:
        cc_col = f'{col}_cc'
        cat_col = f'{col}_cat'
        exog_col = f'{col}_exog'
        if col not in df.columns:
            df[col] = np.nan
        if exog_col in df.columns:
            df[col] = df[col].fillna(df[exog_col])
        if cc_col in df.columns:
            df[col] = df[col].fillna(df[cc_col])
        if cat_col in df.columns:
            df[col] = df[col].fillna(df[cat_col])
        final_val = global_prices.get(col, 1.0 if col == 'discount_ratio' else 0.0)
        df[col] = df[col].fillna(final_val)

    drop_cols = [
        c for c in df.columns
        if c.endswith('_cc') or c.endswith('_cat') or c.endswith('_exog')
    ]
    return df.drop(columns=drop_cols, errors='ignore')


def _normalize_family_calibration_factors(calibration_payload) -> dict[str, float]:
    if not calibration_payload:
        return {}
    if isinstance(calibration_payload, dict) and 'factors' in calibration_payload:
        calibration_payload = calibration_payload.get('factors', {})
    if not isinstance(calibration_payload, dict):
        return {}
    return {
        str(family): float(scale)
        for family, scale in calibration_payload.items()
        if family and scale is not None
    }


def apply_family_calibration(forecast_df: pd.DataFrame, static_df: pd.DataFrame, calibration_payload=None) -> pd.DataFrame:
    """对指定业务家族应用温和的乘法校准。"""
    calibration_factors = _normalize_family_calibration_factors(calibration_payload)
    if forecast_df.empty or static_df.empty or not calibration_factors:
        return forecast_df

    family_lookup = (
        static_df[['variant_key', 'family_tags']]
        .dropna(subset=['variant_key'])
        .drop_duplicates(subset=['variant_key'], keep='last')
        .copy()
    )
    family_lookup['variant_key'] = family_lookup['variant_key'].astype(str)

    calibrated = forecast_df.copy()
    calibrated['variant_key'] = calibrated['variant_key'].astype(str)
    calibrated = calibrated.merge(family_lookup, on='variant_key', how='left')
    calibrated['family_scale'] = calibrated['family_tags'].map(calibration_factors).fillna(1.0)
    calibrated['forecast_qty'] = np.maximum(calibrated['forecast_qty'] * calibrated['family_scale'], 0)
    return calibrated[['variant_key', 'year_month', 'forecast_qty']]


def _iter_family_scopes(target_family: str) -> list[dict]:
    target_family = str(target_family or '').strip()
    if not target_family:
        return []

    parts = target_family.split('|')
    scopes = [{
        'scope_family_tags': target_family,
        'match_type': 'exact',
        'fallback_level': 0,
    }]
    for level in range(1, len(parts)):
        parent_family = '|'.join(parts[:-level]).strip()
        if not parent_family:
            continue
        scopes.append({
            'scope_family_tags': parent_family,
            'match_type': 'prefix',
            'fallback_level': level,
        })
    return scopes


def _iter_focus_family_scopes(target_family: str) -> list[dict]:
    target_family = str(target_family or '').strip()
    if not target_family:
        return []

    override_scopes = FOCUS_FAMILY_CALIBRATION_SCOPE_OVERRIDES.get(target_family)
    if not override_scopes:
        return _iter_family_scopes(target_family)

    scopes = []
    for idx, scope_family_tags in enumerate(override_scopes):
        scope_family_tags = str(scope_family_tags or '').strip()
        if not scope_family_tags:
            continue
        scopes.append({
            'scope_family_tags': scope_family_tags,
            'match_type': 'exact' if idx == 0 else 'prefix',
            'fallback_level': idx,
        })
    return scopes


def _apply_scale_direction_guard(target_family: str, scale: float) -> float:
    direction = FOCUS_FAMILY_CALIBRATION_DIRECTION.get(str(target_family or '').strip())
    if direction == 'up':
        return max(float(scale), 1.0)
    if direction == 'down':
        return min(float(scale), 1.0)
    return float(scale)


def _match_family_scope(series: pd.Series, scope_family_tags: str, match_type: str) -> pd.Series:
    family_series = series.fillna('').astype(str)
    if match_type == 'exact':
        return family_series == scope_family_tags
    prefix = f'{scope_family_tags}|'
    return (family_series == scope_family_tags) | family_series.str.startswith(prefix)


def _normalize_focus_family_calibration_factors(calibration_payload) -> dict[str, float]:
    if not calibration_payload:
        return {}
    raw_factors = calibration_payload.get('factors', {}) if isinstance(calibration_payload, dict) else {}
    normalized = {}
    for key, value in raw_factors.items():
        if isinstance(value, dict):
            scale = value.get('scale')
        else:
            scale = value
        if key and scale is not None:
            normalized[str(key)] = float(scale)
    return normalized


def apply_focus_family_calibration(forecast_df: pd.DataFrame, static_df: pd.DataFrame, calibration_payload=None) -> pd.DataFrame:
    calibration_factors = _normalize_focus_family_calibration_factors(calibration_payload)
    if forecast_df.empty or static_df.empty or not calibration_factors:
        return forecast_df

    original_cols = list(forecast_df.columns)
    calibrated = forecast_df.copy()
    added_source_col = False
    if 'forecast_source' not in calibrated.columns:
        calibrated['forecast_source'] = 'seen'
        added_source_col = True

    family_lookup = (
        static_df[['variant_key', 'family_tags']]
        .dropna(subset=['variant_key'])
        .drop_duplicates(subset=['variant_key'], keep='last')
        .copy()
    )
    family_lookup['variant_key'] = family_lookup['variant_key'].astype(str)

    calibrated['variant_key'] = calibrated['variant_key'].astype(str)
    calibrated = calibrated.merge(family_lookup, on='variant_key', how='left')
    calibrated['focus_calibration_key'] = (
        calibrated['family_tags'].fillna('').astype(str)
        + '::'
        + calibrated['forecast_source'].fillna('seen').astype(str)
    )
    calibrated['focus_family_scale'] = calibrated['focus_calibration_key'].map(calibration_factors).fillna(1.0)
    calibrated['forecast_qty'] = np.maximum(calibrated['forecast_qty'] * calibrated['focus_family_scale'], 0)

    if added_source_col and 'forecast_source' in calibrated.columns:
        calibrated.drop(columns=['forecast_source'], inplace=True, errors='ignore')
    return calibrated[original_cols]


class ColdStartForecaster:
    def __init__(self):
        self.model = None
        self.params = copy.deepcopy(LGBM_PARAMS)
        self.features = [
            'family_tags', 'product_category', 'spec_length', 'spec_size', 'spec_hook', 'spec_qty',
            'is_promo_month', 'is_national_day_month', 'month',
            'cny_offset', 'mid_autumn_offset', 'dragon_boat_offset',
            'avg_base_price', 'avg_tag_price', 'discount_ratio',
            'main_channel', 'top_province', 'cold_start_anchor'
        ]
        self.cat_features = [
            'family_tags', 'product_category', 'spec_length', 'spec_size', 'spec_hook', 'spec_qty',
            'month', 'main_channel', 'top_province'
        ]

    def _prepare_training_frame(self, df: pd.DataFrame, anchor_cutoff: str = None) -> pd.DataFrame:
        df_feat = add_time_features(df.copy())
        if anchor_cutoff is None:
            anchor_cutoff = (df_feat['date'].max() + pd.DateOffset(months=1)).strftime('%Y-%m')
        anchor_src = df_feat[df_feat['date'] < anchor_cutoff]
        family, category, channel_category, global_month = _build_cross_sectional_anchor_tables(anchor_src)
        df_feat = _apply_cross_sectional_anchor(df_feat, family, category, channel_category, global_month)
        df_feat = _fill_price_features(df_feat, anchor_src)
        for col in self.cat_features:
            if col in df_feat.columns:
                df_feat[col] = df_feat[col].astype('category')
        return df_feat

    def train(self, df: pd.DataFrame, anchor_cutoff: str = None):
        df_train = self._prepare_training_frame(df, anchor_cutoff=anchor_cutoff)
        X = df_train[self.features]
        y = np.log1p(df_train['monthly_qty'].clip(lower=0))
        train_data = lgb.Dataset(X, label=y, categorical_feature=self.cat_features)
        print(f"正在使用 {len(self.features)} 个特征训练 {len(X)} 行数据 (Cold-start Direct Qty)...")
        self.model = lgb.train(self.params, train_data, num_boost_round=400)
        return self

    def save(self, path):
        if self.model is None:
            raise ValueError("模型尚未训练，无法保存。")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.model.save_model(path)
        print(f"冷启动模型已保存至: {path}")

    def load(self, path):
        if not os.path.exists(path):
            raise FileNotFoundError(f"未找到模型文件: {path}")
        self.model = lgb.Booster(model_file=path)
        print(f"冷启动模型已从 {path} 加载。")
        return self

    def predict_new_variants(self, history_df: pd.DataFrame, candidate_df: pd.DataFrame, steps=FORECAST_HORIZON, exogenous_df=None, anchor_cutoff=None):
        history_df = history_df.sort_values(['variant_key', 'date']).copy()
        candidate_df = candidate_df.sort_values(['variant_key', 'date']).copy()
        if history_df.empty or candidate_df.empty:
            return pd.DataFrame(columns=['variant_key', 'year_month', 'forecast_qty'])

        seen_variants = set(history_df['variant_key'].astype(str))
        static_cols = [
            'family_tags', 'product_category', 'spec_length', 'spec_size',
            'spec_hook', 'spec_qty', 'main_channel', 'top_province'
        ]
        candidate_static = candidate_df.groupby('variant_key', observed=True)[static_cols].last().reset_index()
        new_variants = candidate_static[~candidate_static['variant_key'].astype(str).isin(seen_variants)].copy()
        if new_variants.empty:
            return pd.DataFrame(columns=['variant_key', 'year_month', 'forecast_qty'])

        start_date = history_df['date'].max() + pd.DateOffset(months=1)
        future_dates = pd.date_range(start=start_date, periods=steps, freq='MS')
        future_grid = pd.DataFrame([
            {'variant_key': v, 'date': d} for v in new_variants['variant_key'] for d in future_dates
        ])
        future_df = future_grid.merge(new_variants, on='variant_key', how='left')

        if anchor_cutoff is None:
            anchor_cutoff = start_date.strftime('%Y-%m')
        anchor_src = history_df[history_df['date'] < anchor_cutoff].copy()

        future_df = add_time_features(future_df)
        family, category, channel_category, global_month = _build_cross_sectional_anchor_tables(anchor_src)
        future_df = _apply_cross_sectional_anchor(future_df, family, category, channel_category, global_month)
        future_df = _fill_price_features(future_df, anchor_src, exogenous_df=exogenous_df)
        for col in self.cat_features:
            if col in future_df.columns:
                future_df[col] = future_df[col].astype('category')

        preds = np.expm1(self.model.predict(future_df[self.features]))
        preds = np.maximum(preds, 0)
        return pd.DataFrame({
            'variant_key': future_df['variant_key'],
            'year_month': future_df['date'].dt.strftime('%Y-%m'),
            'forecast_qty': preds
        })

class SKUForecaster:
    def __init__(self, mode='tail'):
        """初始化预测器。支持 'top' 和 'tail' 模式。"""
        self.model = None
        # 使用深拷贝防止修改全局字典，避免 Top 模型的超参污染 Tail 模型
        import copy
        self.params = copy.deepcopy(LGBM_PARAMS)
        self.mode = mode
        
        # 移除 autoregressive 特征 (lag, rolling)，防止递归衰减
        # 只保留稳定的 属性特征 + 季节性锚点 + 价格 + 假日大促
        self.features = [
            'family_tags', 'product_category', 'spec_length', 'spec_size', 'spec_hook', 'spec_qty',
            'is_promo_month', 'is_national_day_month', 'month',
            'cny_offset', 'mid_autumn_offset', 'dragon_boat_offset',
            'avg_base_price', 'avg_tag_price',
            'seasonal_anchor', 'main_channel', 'discount_ratio', 'top_province'
        ]
        # if self.mode == 'top':
        #     # Top 模型专属特征：引入强效近期动量
        #     self.features.extend(['momentum_1_3', 'momentum_3_6'])
            
        self.cat_features = [
            'family_tags', 'product_category', 'spec_length', 'spec_size', 'spec_hook', 'spec_qty', 'month', 'main_channel', 'top_province'
        ]

    def train(self, df):
        """训练模型 (预测 Qty 与 Anchor 的比例)。"""
        # 构建特征 (包含 seasonal_anchor)
        df_feat = build_features(df, mode=self.mode)
        
        # 移除 NaN 和非法锚点
        df_train = df_feat.dropna(subset=['lag_1', 'seasonal_anchor'])
        df_train = df_train[df_train['seasonal_anchor'] > 0]
        
        # 排除非特征列和“未来不可知”的价格列
        drop_cols = ['monthly_qty', 'date', 'year_month', 'variant_key', 'seasonal_anchor'] + FUTURE_UNKNOWN_PRICE_COLS
        X = df_train.drop(columns=drop_cols, errors='ignore')
        
        # 目标值：当前销量 / 季节性锚点 (即相对于历史平均该月的比例)
        y = df_train['monthly_qty'] / df_train['seasonal_anchor']
        
        # 目标值：当前销量 / 季节性锚点
        y = df_train['monthly_qty'] / df_train['seasonal_anchor']
        
        # 只取显式定义的特征，防止泄露或递归污染
        X = df_train[self.features]
        
        train_data = lgb.Dataset(X, label=y, categorical_feature=self.cat_features)
        
        # 针对 Top 模型动态调低复杂度防止过拟合 (仅有 8000 行数据)
        rounds = 1000
        if self.mode == 'top':
            self.params['num_leaves'] = 15
            self.params['learning_rate'] = 0.03
            rounds = 200
            
        print(f"正在使用 {len(self.features)} 个特征训练 {len(X)} 行数据 (Profile-based Ratio)...")
        self.model = lgb.train(self.params, train_data, num_boost_round=rounds)
        return self

    def save(self, path):
        """将模型保存至磁盘。"""
        if self.model is None:
            raise ValueError("模型尚未训练，无法保存。")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.model.save_model(path)
        print(f"模型已保存至: {path}")

    def load(self, path):
        """从磁盘加载模型。"""
        if not os.path.exists(path):
            raise FileNotFoundError(f"未找到模型文件: {path}")
        self.model = lgb.Booster(model_file=path)
        print(f"模型已从 {path} 加载。")
        return self

    def predict_recursive(self, history_df, steps=FORECAST_HORIZON, exogenous_df=None, anchor_cutoff=None, candidate_df=None):
        """基于 Variant Key 进行递归比例预测。"""
        # 为了避免 Recursive Truncation Skew (即递归过程中窗口截断导致锚点漂移)，
        # 我们在这里基于全量历史一次性计算出所有的 Seasonal Anchor。
        history_df = history_df.sort_values(['variant_key', 'date']).copy()
        history_df['month_val'] = history_df['date'].dt.month
        
        # 确定锚点截止日期 (与 features.py 逻辑对齐)
        max_date = history_df['date'].max()
        if anchor_cutoff is None:
            anchor_cutoff = (max_date + pd.offsets.MonthBegin(1)).strftime('%Y-%m')
        
        anchor_src = history_df[history_df['date'] < anchor_cutoff]
        variant_seasonal = anchor_src.groupby(['variant_key', 'month_val'], observed=True)['monthly_qty'].mean().reset_index()
        variant_seasonal.rename(columns={'monthly_qty': 'seasonal_anchor'}, inplace=True)
        
        family_seasonal = anchor_src.groupby(['family_tags', 'month_val'], observed=True)['monthly_qty'].mean().reset_index()
        family_seasonal.rename(columns={'monthly_qty': 'family_seasonal_anchor'}, inplace=True)
        category_seasonal = anchor_src.groupby(['product_category', 'month_val'], observed=True)['monthly_qty'].mean().reset_index()
        category_seasonal.rename(columns={'monthly_qty': 'category_seasonal_anchor'}, inplace=True)
        channel_category_seasonal = anchor_src.groupby(['main_channel', 'product_category', 'month_val'], observed=True)['monthly_qty'].mean().reset_index()
        channel_category_seasonal.rename(columns={'monthly_qty': 'channel_category_seasonal_anchor'}, inplace=True)
        global_month_seasonal = anchor_src.groupby(['month_val'], observed=True)['monthly_qty'].mean().reset_index()
        global_month_seasonal.rename(columns={'monthly_qty': 'global_month_seasonal_anchor'}, inplace=True)

        # 预计算全量锚点表 (Variant + Month -> Final Anchor)
        # 如果提供 candidate_df，则将“历史种子中不存在但候选集合里存在”的冷启动 SKU 一并纳入预测集合。
        static_cols = [
            'family_tags', 'product_category', 'spec_length', 'spec_size', 'spec_hook', 'spec_qty', 'main_channel', 'top_province'
        ]
        if candidate_df is not None and not candidate_df.empty:
            candidate_static = candidate_df.sort_values(['variant_key', 'date']).groupby('variant_key', observed=True)[static_cols].last().reset_index()
        else:
            candidate_static = history_df.groupby('variant_key', observed=True)[static_cols].last().reset_index()

        # 获取所有静态属性用于家族/品类级兜底
        static_info = candidate_static[['variant_key', 'family_tags', 'product_category', 'main_channel']].copy()
        all_variants = candidate_static['variant_key'].unique()
        all_months = range(1, 13)
        full_anchor_grid = pd.DataFrame([
            {'variant_key': v, 'month_val': m} for v in all_variants for m in all_months
        ])
        full_anchor_grid = full_anchor_grid.merge(static_info, on='variant_key', how='left')
        full_anchor_grid = full_anchor_grid.merge(variant_seasonal, on=['variant_key', 'month_val'], how='left')
        full_anchor_grid = full_anchor_grid.merge(family_seasonal, on=['family_tags', 'month_val'], how='left')
        full_anchor_grid = full_anchor_grid.merge(category_seasonal, on=['product_category', 'month_val'], how='left')
        full_anchor_grid = full_anchor_grid.merge(channel_category_seasonal, on=['main_channel', 'product_category', 'month_val'], how='left')
        full_anchor_grid = full_anchor_grid.merge(global_month_seasonal, on=['month_val'], how='left')
        full_anchor_grid['seasonal_anchor'] = full_anchor_grid['seasonal_anchor'].fillna(full_anchor_grid['family_seasonal_anchor'])
        full_anchor_grid['seasonal_anchor'] = full_anchor_grid['seasonal_anchor'].fillna(full_anchor_grid['channel_category_seasonal_anchor'])
        full_anchor_grid['seasonal_anchor'] = full_anchor_grid['seasonal_anchor'].fillna(full_anchor_grid['category_seasonal_anchor'])
        full_anchor_grid['seasonal_anchor'] = full_anchor_grid['seasonal_anchor'].fillna(full_anchor_grid['global_month_seasonal_anchor'])
        full_anchor_grid['seasonal_anchor'] = full_anchor_grid['seasonal_anchor'].fillna(0)
        final_anchors = full_anchor_grid[['variant_key', 'month_val', 'seasonal_anchor']].copy()

        # 为冷启动 SKU 构造一行“预测起点前的零销量引导行”，让递归特征可计算。
        current_variants = set(history_df['variant_key'].astype(str))
        new_variant_mask = ~candidate_static['variant_key'].astype(str).isin(current_variants)
        new_variant_static = candidate_static[new_variant_mask].copy()
        last_date = history_df['date'].max()
        if not new_variant_static.empty:
            latest_prices = history_df.groupby('variant_key', observed=True)[FUTURE_UNKNOWN_PRICE_COLS].last().reset_index()
            channel_category_prices = history_df.groupby(['main_channel', 'product_category'], observed=True)[FUTURE_UNKNOWN_PRICE_COLS].median().reset_index()
            category_prices = history_df.groupby(['product_category'], observed=True)[FUTURE_UNKNOWN_PRICE_COLS].median().reset_index()
            global_prices = history_df[FUTURE_UNKNOWN_PRICE_COLS].median()

            new_variant_static = new_variant_static.merge(channel_category_prices, on=['main_channel', 'product_category'], how='left', suffixes=('', '_cc'))
            new_variant_static = new_variant_static.merge(category_prices, on=['product_category'], how='left', suffixes=('', '_cat'))
            for col in FUTURE_UNKNOWN_PRICE_COLS:
                cc_col = f'{col}_cc'
                cat_col = f'{col}_cat'
                if col not in new_variant_static.columns:
                    new_variant_static[col] = np.nan
                
                # 分级填充价格 (分级兜底: 渠道+类目 -> 类目 -> 大盘)
                if cc_col in new_variant_static.columns:
                    new_variant_static[col] = new_variant_static[col].fillna(new_variant_static[cc_col])
                if cat_col in new_variant_static.columns:
                    new_variant_static[col] = new_variant_static[col].fillna(new_variant_static[cat_col])
                
                # 终端兜底
                final_val = global_prices.get(col, 1.0 if col == 'discount_ratio' else 0.0)
                new_variant_static[col] = new_variant_static[col].fillna(final_val)
            drop_cols = [c for c in new_variant_static.columns if c.endswith('_cc') or c.endswith('_cat')]
            new_variant_static.drop(columns=drop_cols, inplace=True, errors='ignore')

            bootstrap_rows = new_variant_static.copy()
            bootstrap_rows['date'] = last_date
            bootstrap_rows['year_month'] = pd.to_datetime(last_date).strftime('%Y-%m')
            bootstrap_rows['month_val'] = pd.to_datetime(last_date).month
            bootstrap_anchor = final_anchors[final_anchors['month_val'] == pd.to_datetime(last_date).month][['variant_key', 'seasonal_anchor']]
            bootstrap_rows = bootstrap_rows.merge(bootstrap_anchor, on='variant_key', how='left')
            bootstrap_rows['monthly_qty'] = bootstrap_rows['seasonal_anchor'].fillna(0.0)
            bootstrap_rows['total_paid_amount'] = (
                bootstrap_rows['monthly_qty']
                * bootstrap_rows['avg_tag_price'].fillna(0)
                * bootstrap_rows['discount_ratio'].fillna(1.0)
            )
            bootstrap_rows.drop(columns=['seasonal_anchor'], inplace=True, errors='ignore')
            history_df = pd.concat([history_df, bootstrap_rows], ignore_index=True)
            history_df = history_df.sort_values(['variant_key', 'date']).reset_index(drop=True)

        # 将锚点注入初始 history_df (即 current_df)
        current_df = history_df.merge(final_anchors, on=['variant_key', 'month_val'], how='left')
        current_df.drop(columns=['month_val'], inplace=True)
        
        # 获取预测开始日期
        last_date = current_df['date'].max()
        forecasts = []
        
        # 分离静态特征与可变价格特征
        variant_static = current_df.groupby('variant_key', observed=True)[static_cols].last().reset_index()
        family_variant_counts = variant_static.groupby('family_tags', observed=True)['variant_key'].nunique()
        
        # 默认预测价格 (和折算率兜底)
        default_prices = current_df.groupby('variant_key', observed=True)[FUTURE_UNKNOWN_PRICE_COLS].last().reset_index()
        max_needed = 24 # 保持足够的历史窗口用于特征计算
        
        for i in range(1, steps + 1):
            next_date = last_date + pd.DateOffset(months=i)
            next_month = next_date.month
            print(f"正在预测 {next_date.strftime('%Y-%m')} (第 {i}/{steps} 步)...")
            
            # 1. 构造当前步的基础行
            step_df = variant_static.copy()
            step_df['date'] = next_date
            step_df['monthly_qty'] = np.nan
            
            # 2. 注入预计算的静态锚点 (关键：彻底消除 Truncation Skew)
            step_anchors = final_anchors[final_anchors['month_val'] == next_month][['variant_key', 'seasonal_anchor']]
            step_df = step_df.merge(step_anchors, on='variant_key', how='left')
            
            # 2. 注入外部调价计划 (即时生效)
            if exogenous_df is not None and not exogenous_df.empty:
                # 容错处理：动态检查业务计划中存在的列 (防止旧版 CSV 缺少 discount_ratio 导致崩溃)
                available_cols = ['variant_key'] + [c for c in FUTURE_UNKNOWN_PRICE_COLS if c in exogenous_df.columns]
                month_prices = exogenous_df[exogenous_df['date'] == next_date][available_cols]
                if not month_prices.empty:
                    # 合并计划价格
                    step_df = step_df.merge(month_prices, on='variant_key', how='left', suffixes=('', '_exog'))
                    for col in FUTURE_UNKNOWN_PRICE_COLS:
                        if f'{col}_exog' in step_df.columns:
                            # 优先采用计划价格，否则维持最后已知价
                            step_df[col] = step_df[f'{col}_exog'].fillna(step_df['variant_key'].map(default_prices.set_index('variant_key')[col]))
                            step_df.drop(columns=[f'{col}_exog'], inplace=True)
            
            # 3. 填充缺失价格 (兜底使用上月价格)
            for col in FUTURE_UNKNOWN_PRICE_COLS:
                if col not in step_df.columns:
                    step_df[col] = step_df['variant_key'].map(default_prices.set_index('variant_key')[col])
                else:
                    step_df[col] = step_df[col].fillna(step_df['variant_key'].map(default_prices.set_index('variant_key')[col]))
            
            # --- 关键修正：价格状态持久化 ---
            # 更新 default_prices 为当前月实际采用的价格，以此作为下一轮递归的起始点。
            # 这确保了 exogenous_df 中的一次性调价能产生持续性影响，而不会在下个月被打回历史原形。
            default_prices = step_df[['variant_key'] + FUTURE_UNKNOWN_PRICE_COLS].copy()
            
            # 4. 计算特征 (build_features 现在直接使用当月价格)
            combined_df = pd.concat([current_df, step_df], ignore_index=True)
            combined_df = combined_df.sort_values(['variant_key', 'date'])
            feat_df = build_features(combined_df, mode=self.mode)
            
            # 5. 提取当前步特征向量并预测
            current_step_feat = feat_df[feat_df['date'] == next_date].copy()
            X_pred = current_step_feat[self.features]
            
            y_ratio = self.model.predict(X_pred)
            y_ratio = np.maximum(y_ratio, 0)
            
            print(f"[{next_date.strftime('%Y-%m')}] {self.mode} Ratio mean: {y_ratio.mean():.4f}, max: {y_ratio.max():.4f}")

            
            # 6. 还原销量: 有锚点时走 Ratio * Anchor；无锚点时回退到近期销量基线
            current_step_feat['family_variant_count'] = current_step_feat['family_tags'].map(family_variant_counts).replace(0, np.nan)
            current_step_feat['family_recent_per_sku'] = (
                current_step_feat['family_rolling_6'] / current_step_feat['family_variant_count']
            )
            fallback_base = current_step_feat[
                ['rolling_mean_3', 'rolling_mean_6', 'lag_1', 'family_recent_per_sku']
            ].fillna(0).clip(lower=0).max(axis=1).values
            fallback_ratio = np.clip(y_ratio, 0.5, 1.5)
            y_pred = np.where(
                current_step_feat['seasonal_anchor'].values > 0,
                y_ratio * current_step_feat['seasonal_anchor'].values,
                fallback_base * fallback_ratio
            )
            
            # 6. 更新结果供下一波递归
            combined_df.loc[combined_df['date'] == next_date, 'monthly_qty'] = y_pred
            
            res = pd.DataFrame({
                'variant_key': current_step_feat['variant_key'],
                'year_month': current_step_feat['date'].dt.strftime('%Y-%m'),
                'forecast_qty': y_pred
            })
            forecasts.append(res)
            
            # 保持近期窗口
            current_df = combined_df.groupby('variant_key', observed=True).tail(max_needed).copy()
            
        return pd.concat(forecasts, ignore_index=True)


def save_family_calibration_artifact(artifact: dict, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(artifact, f, ensure_ascii=False, indent=2)
    print(f"family 校准产物已保存至: {path}")


def load_family_calibration_artifact(path: str) -> dict:
    if not os.path.exists(path):
        raise FileNotFoundError(f"未找到 family 校准产物: {path}")
    with open(path, 'r', encoding='utf-8') as f:
        artifact = json.load(f)
    print(f"family 校准产物已从 {path} 加载。")
    return artifact


def learn_family_calibration_artifact(
    df: pd.DataFrame,
    calibration_months: int = FAMILY_CALIBRATION_WINDOW_MONTHS,
    top_sku_threshold: int = TOP_SKU_THRESHOLD,
    max_families: int = FAMILY_CALIBRATION_MAX_FAMILIES,
    min_actual_sum: float = FAMILY_CALIBRATION_MIN_ACTUAL_SUM,
    min_abs_bias: float = FAMILY_CALIBRATION_MIN_ABS_BIAS,
    min_scale: float = FAMILY_CALIBRATION_MIN_SCALE,
    max_scale: float = FAMILY_CALIBRATION_MAX_SCALE,
    priority_families: Optional[list[str]] = None,
) -> dict:
    """
    基于最近若干个月的 rolling one-step 预测自动学习 family 校准系数。
    这里不做多次重训，而是在校准窗口起点前训练一次模型，然后逐月滚动预测、逐月喂入真实值。
    """
    artifact = {
        'generated_at': pd.Timestamp.now().isoformat(),
        'method': 'rolling_one_step_family_calibration',
        'window_months': int(calibration_months),
        'selection_mode': 'business_priority',
        'priority_families': list(priority_families or FAMILY_CALIBRATION_PRIORITY_FAMILIES),
        'factors': {},
        'details': [],
        'candidate_details': [],
    }

    if df.empty or calibration_months <= 0:
        return artifact

    calib_df = df.copy()
    calib_df['variant_key'] = calib_df['variant_key'].astype(str)
    calib_df['date'] = pd.to_datetime(calib_df['date'])
    if 'year_month' not in calib_df.columns:
        calib_df['year_month'] = calib_df['date'].dt.strftime('%Y-%m')
    calib_df = calib_df.sort_values(['date', 'variant_key']).reset_index(drop=True)

    unique_months = sorted(pd.Timestamp(x) for x in calib_df['date'].drop_duplicates())
    if len(unique_months) <= calibration_months:
        return artifact

    rolling_months = unique_months[-calibration_months:]
    calibration_start = rolling_months[0]
    calibration_end = rolling_months[-1]
    artifact['window_start'] = calibration_start.strftime('%Y-%m')
    artifact['window_end'] = calibration_end.strftime('%Y-%m')

    train_base = calib_df[calib_df['date'] < calibration_start].copy()
    if train_base.empty or train_base['date'].nunique() < 12:
        return artifact

    sku_volumes = train_base.groupby('variant_key', observed=True)['monthly_qty'].sum().sort_values(ascending=False)
    top_skus = sku_volumes.head(top_sku_threshold).index.fillna("").astype(str).tolist()
    artifact['top_sku_threshold'] = int(top_sku_threshold)

    train_top = train_base[train_base['variant_key'].isin(top_skus)].copy()
    train_tail = train_base[~train_base['variant_key'].isin(top_skus)].copy()

    if train_top.empty or train_tail.empty:
        return artifact

    top_model = SKUForecaster(mode='top')
    top_model.train(train_top)

    tail_model = SKUForecaster(mode='tail')
    tail_model.train(train_tail)

    cold_model = ColdStartForecaster()
    cold_model.train(train_base, anchor_cutoff=calibration_start.strftime('%Y-%m'))

    rolling_history = train_base.copy()
    month_eval_frames: list[pd.DataFrame] = []

    for month_date in rolling_months:
        month_str = month_date.strftime('%Y-%m')
        actual_month = calib_df[calib_df['date'] == month_date].copy()
        if actual_month.empty:
            continue

        history_top = rolling_history[rolling_history['variant_key'].isin(top_skus)].copy()
        history_tail = rolling_history[~rolling_history['variant_key'].isin(top_skus)].copy()

        forecast_parts = []
        if not history_top.empty:
            forecast_parts.append(
                top_model.predict_recursive(
                    history_top,
                    steps=1,
                    anchor_cutoff=month_str,
                    candidate_df=history_top,
                )
            )
        if not history_tail.empty:
            forecast_parts.append(
                tail_model.predict_recursive(
                    history_tail,
                    steps=1,
                    anchor_cutoff=month_str,
                    candidate_df=history_tail,
                )
            )

        forecast_parts.append(
            cold_model.predict_new_variants(
                rolling_history,
                actual_month,
                steps=1,
                anchor_cutoff=month_str,
            )
        )

        month_forecast = pd.concat(forecast_parts, ignore_index=True)
        month_eval = actual_month[['variant_key', 'family_tags', 'year_month', 'monthly_qty']].merge(
            month_forecast[['variant_key', 'year_month', 'forecast_qty']],
            on=['variant_key', 'year_month'],
            how='left',
        )
        month_eval['forecast_qty'] = month_eval['forecast_qty'].fillna(0)
        month_eval_frames.append(month_eval)

        rolling_history = (
            pd.concat([rolling_history, actual_month], ignore_index=True)
            .sort_values(['variant_key', 'date'])
            .reset_index(drop=True)
        )

    if not month_eval_frames:
        return artifact

    rolling_eval = pd.concat(month_eval_frames, ignore_index=True)
    family_metrics = (
        rolling_eval.groupby('family_tags', observed=True)
        .agg(
            actual_sum=('monthly_qty', 'sum'),
            forecast_sum=('forecast_qty', 'sum'),
            sku_count=('variant_key', 'nunique'),
            row_count=('variant_key', 'size'),
        )
        .reset_index()
    )
    family_metrics['bias'] = np.where(
        family_metrics['actual_sum'] > 0,
        (family_metrics['forecast_sum'] - family_metrics['actual_sum']) / family_metrics['actual_sum'],
        0.0,
    )
    family_metrics['score'] = (family_metrics['actual_sum'] - family_metrics['forecast_sum']).abs()
    family_month_metrics = (
        rolling_eval.groupby(['family_tags', 'year_month'], observed=True)
        .agg(
            actual_sum=('monthly_qty', 'sum'),
            forecast_sum=('forecast_qty', 'sum'),
        )
        .reset_index()
    )
    family_month_metrics['bias'] = np.where(
        family_month_metrics['actual_sum'] > 0,
        (family_month_metrics['forecast_sum'] - family_month_metrics['actual_sum']) / family_month_metrics['actual_sum'],
        0.0,
    )
    family_month_metrics['bias_sign'] = np.sign(family_month_metrics['bias'])
    family_stability = (
        family_month_metrics.groupby('family_tags', observed=True)
        .agg(
            active_months=('year_month', 'nunique'),
            mean_abs_bias=('bias', lambda s: float(np.mean(np.abs(s)))),
            consistent_sign_ratio=(
                'bias_sign',
                lambda s: float(
                    max((s > 0).sum(), (s < 0).sum()) / max(((s != 0).sum()), 1)
                )
            ),
        )
        .reset_index()
    )
    family_metrics = family_metrics.merge(family_stability, on='family_tags', how='left')
    family_metrics['active_months'] = family_metrics['active_months'].fillna(0).astype(int)
    family_metrics['mean_abs_bias'] = family_metrics['mean_abs_bias'].fillna(family_metrics['bias'].abs())
    family_metrics['consistent_sign_ratio'] = family_metrics['consistent_sign_ratio'].fillna(0.0)

    priority_families = set(priority_families or FAMILY_CALIBRATION_PRIORITY_FAMILIES)
    family_metrics['is_priority_family'] = family_metrics['family_tags'].isin(priority_families)
    family_metrics['priority_rank'] = np.where(family_metrics['is_priority_family'], 0, 1)
    family_metrics['priority_score'] = (
        family_metrics['score']
        * (1.0 + family_metrics['consistent_sign_ratio'])
        * family_metrics['mean_abs_bias'].clip(lower=0.1)
    )

    eligible = family_metrics[
        (family_metrics['actual_sum'] >= min_actual_sum)
        & (family_metrics['bias'].abs() >= min_abs_bias)
        & (family_metrics['active_months'] >= max(2, min(calibration_months, 2)))
    ].copy()
    if eligible.empty:
        return artifact

    denom = eligible['forecast_sum'].clip(lower=1.0)
    eligible['scale'] = np.sqrt(eligible['actual_sum'] / denom).clip(lower=min_scale, upper=max_scale)
    eligible = eligible.sort_values(
        [
            'priority_rank',
            'priority_score',
            'consistent_sign_ratio',
            'actual_sum',
            'score',
        ],
        ascending=[True, False, False, False, False],
    ).reset_index(drop=True)
    eligible['selection_rank'] = range(1, len(eligible) + 1)
    selected = eligible.head(max_families).copy()

    artifact['factors'] = {
        row['family_tags']: round(float(row['scale']), 6)
        for _, row in selected.iterrows()
    }
    artifact['details'] = [
        {
            'family_tags': row['family_tags'],
            'actual_sum': float(row['actual_sum']),
            'forecast_sum': float(row['forecast_sum']),
            'bias': float(row['bias']),
            'scale': round(float(row['scale']), 6),
            'sku_count': int(row['sku_count']),
            'row_count': int(row['row_count']),
            'score': float(row['score']),
            'priority_score': float(row['priority_score']),
            'active_months': int(row['active_months']),
            'mean_abs_bias': float(row['mean_abs_bias']),
            'consistent_sign_ratio': float(row['consistent_sign_ratio']),
            'is_priority_family': bool(row['is_priority_family']),
            'selection_rank': int(row['selection_rank']),
        }
        for _, row in selected.iterrows()
    ]
    artifact['candidate_details'] = [
        {
            'family_tags': row['family_tags'],
            'actual_sum': float(row['actual_sum']),
            'forecast_sum': float(row['forecast_sum']),
            'bias': float(row['bias']),
            'scale': round(float(row['scale']), 6),
            'sku_count': int(row['sku_count']),
            'row_count': int(row['row_count']),
            'score': float(row['score']),
            'priority_score': float(row['priority_score']),
            'active_months': int(row['active_months']),
            'mean_abs_bias': float(row['mean_abs_bias']),
            'consistent_sign_ratio': float(row['consistent_sign_ratio']),
            'is_priority_family': bool(row['is_priority_family']),
            'selection_rank': int(row['selection_rank']),
            'selected': bool(row['selection_rank'] <= max_families),
        }
        for _, row in eligible.iterrows()
    ]
    return artifact


def learn_focus_family_calibration_artifact(
    df: pd.DataFrame,
    focus_families: Optional[list[str]] = None,
    calibration_months: int = FOCUS_FAMILY_CALIBRATION_WINDOW_MONTHS,
    top_sku_threshold: int = TOP_SKU_THRESHOLD,
    min_actual_sum: float = FOCUS_FAMILY_CALIBRATION_MIN_ACTUAL_SUM,
    min_active_months: int = FOCUS_FAMILY_CALIBRATION_MIN_ACTIVE_MONTHS,
    min_abs_bias: float = FOCUS_FAMILY_CALIBRATION_MIN_ABS_BIAS,
    min_scale: float = FAMILY_CALIBRATION_MIN_SCALE,
    max_scale: float = FAMILY_CALIBRATION_MAX_SCALE,
    shrink_actual_ref: float = FOCUS_FAMILY_CALIBRATION_SHRINK_ACTUAL_REF,
    shrink_month_ref: float = FOCUS_FAMILY_CALIBRATION_SHRINK_MONTH_REF,
    parent_decay: float = FOCUS_FAMILY_CALIBRATION_PARENT_DECAY,
) -> dict:
    artifact = {
        'generated_at': pd.Timestamp.now().isoformat(),
        'method': 'focus_family_branch_calibration',
        'window_months': int(calibration_months),
        'focus_families': list(focus_families or FOCUS_FAMILY_CALIBRATION_WHITELIST),
        'scope_overrides': FOCUS_FAMILY_CALIBRATION_SCOPE_OVERRIDES,
        'direction_guard': FOCUS_FAMILY_CALIBRATION_DIRECTION,
        'factors': {},
        'details': [],
        'candidate_details': [],
    }

    focus_families = list(focus_families or FOCUS_FAMILY_CALIBRATION_WHITELIST)
    if df.empty or calibration_months <= 0 or not focus_families:
        return artifact

    calib_df = df.copy()
    calib_df['variant_key'] = calib_df['variant_key'].astype(str)
    calib_df['date'] = pd.to_datetime(calib_df['date'])
    if 'year_month' not in calib_df.columns:
        calib_df['year_month'] = calib_df['date'].dt.strftime('%Y-%m')
    calib_df = calib_df.sort_values(['date', 'variant_key']).reset_index(drop=True)

    unique_months = sorted(pd.Timestamp(x) for x in calib_df['date'].drop_duplicates())
    if len(unique_months) <= calibration_months:
        return artifact

    rolling_months = unique_months[-calibration_months:]
    calibration_start = rolling_months[0]
    calibration_end = rolling_months[-1]
    artifact['window_start'] = calibration_start.strftime('%Y-%m')
    artifact['window_end'] = calibration_end.strftime('%Y-%m')

    train_base = calib_df[calib_df['date'] < calibration_start].copy()
    if train_base.empty or train_base['date'].nunique() < 12:
        return artifact

    sku_volumes = train_base.groupby('variant_key', observed=True)['monthly_qty'].sum().sort_values(ascending=False)
    top_skus = sku_volumes.head(top_sku_threshold).index.fillna("").astype(str).tolist()
    artifact['top_sku_threshold'] = int(top_sku_threshold)

    train_top = train_base[train_base['variant_key'].isin(top_skus)].copy()
    train_tail = train_base[~train_base['variant_key'].isin(top_skus)].copy()
    if train_top.empty or train_tail.empty:
        return artifact

    top_model = SKUForecaster(mode='top')
    top_model.train(train_top)

    tail_model = SKUForecaster(mode='tail')
    tail_model.train(train_tail)

    cold_model = ColdStartForecaster()
    cold_model.train(train_base, anchor_cutoff=calibration_start.strftime('%Y-%m'))

    rolling_history = train_base.copy()
    month_eval_frames = []

    for month_date in rolling_months:
        month_str = month_date.strftime('%Y-%m')
        actual_month = calib_df[calib_df['date'] == month_date].copy()
        if actual_month.empty:
            continue

        seen_variants = set(rolling_history['variant_key'].astype(str))
        actual_month['forecast_source'] = np.where(
            actual_month['variant_key'].astype(str).isin(seen_variants),
            'seen',
            'cold',
        )

        history_top = rolling_history[rolling_history['variant_key'].isin(top_skus)].copy()
        history_tail = rolling_history[~rolling_history['variant_key'].isin(top_skus)].copy()

        forecast_parts = []
        if not history_top.empty:
            top_part = top_model.predict_recursive(
                history_top,
                steps=1,
                anchor_cutoff=month_str,
                candidate_df=history_top,
            )
            top_part['forecast_source'] = 'seen'
            forecast_parts.append(top_part)
        if not history_tail.empty:
            tail_part = tail_model.predict_recursive(
                history_tail,
                steps=1,
                anchor_cutoff=month_str,
                candidate_df=history_tail,
            )
            tail_part['forecast_source'] = 'seen'
            forecast_parts.append(tail_part)

        cold_part = cold_model.predict_new_variants(
            rolling_history,
            actual_month.drop(columns=['forecast_source'], errors='ignore'),
            steps=1,
            anchor_cutoff=month_str,
        )
        cold_part['forecast_source'] = 'cold'
        forecast_parts.append(cold_part)

        month_forecast = pd.concat(forecast_parts, ignore_index=True)
        month_eval = actual_month[['variant_key', 'family_tags', 'year_month', 'monthly_qty', 'forecast_source']].merge(
            month_forecast[['variant_key', 'year_month', 'forecast_source', 'forecast_qty']],
            on=['variant_key', 'year_month', 'forecast_source'],
            how='left',
        )
        month_eval['forecast_qty'] = month_eval['forecast_qty'].fillna(0)
        month_eval_frames.append(month_eval)

        rolling_history = (
            pd.concat([rolling_history, actual_month.drop(columns=['forecast_source'], errors='ignore')], ignore_index=True)
            .sort_values(['variant_key', 'date'])
            .reset_index(drop=True)
        )

    if not month_eval_frames:
        return artifact

    rolling_eval = pd.concat(month_eval_frames, ignore_index=True)

    for target_family in focus_families:
        for forecast_source in ['seen', 'cold']:
            selected_rule = None
            scopes = _iter_focus_family_scopes(target_family)
            for scope in scopes:
                source_eval = rolling_eval[rolling_eval['forecast_source'] == forecast_source].copy()
                if source_eval.empty:
                    continue
                scope_mask = _match_family_scope(
                    source_eval['family_tags'],
                    scope['scope_family_tags'],
                    scope['match_type'],
                )
                scope_eval = source_eval[scope_mask].copy()
                if scope_eval.empty:
                    artifact['candidate_details'].append({
                        'target_family_tags': target_family,
                        'forecast_source': forecast_source,
                        'scope_family_tags': scope['scope_family_tags'],
                        'match_type': scope['match_type'],
                        'fallback_level': int(scope['fallback_level']),
                        'eligible': False,
                        'reason': 'empty_scope',
                    })
                    continue

                month_metrics = (
                    scope_eval.groupby('year_month', observed=True)
                    .agg(
                        actual_sum=('monthly_qty', 'sum'),
                        forecast_sum=('forecast_qty', 'sum'),
                    )
                    .reset_index()
                )
                active_months = int(month_metrics['year_month'].nunique())
                actual_sum = float(scope_eval['monthly_qty'].sum())
                forecast_sum = float(scope_eval['forecast_qty'].sum())
                bias = (forecast_sum - actual_sum) / actual_sum if actual_sum > 0 else 0.0
                raw_scale = np.sqrt(actual_sum / max(forecast_sum, 1.0)) if actual_sum > 0 else 1.0
                actual_weight = min(1.0, actual_sum / max(shrink_actual_ref, 1.0))
                month_weight = min(1.0, active_months / max(shrink_month_ref, 1.0))
                hierarchy_weight = float(parent_decay) ** int(scope['fallback_level'])
                shrinkage_weight = actual_weight * month_weight * hierarchy_weight
                scale = 1.0 + (raw_scale - 1.0) * shrinkage_weight
                scale = float(np.clip(scale, min_scale, max_scale))
                direction = FOCUS_FAMILY_CALIBRATION_DIRECTION.get(target_family)
                scale_before_guard = scale
                scale = _apply_scale_direction_guard(target_family, scale)
                eligible = (
                    actual_sum >= min_actual_sum
                    and active_months >= int(min_active_months)
                    and abs(bias) >= min_abs_bias
                )

                candidate_detail = {
                    'target_family_tags': target_family,
                    'forecast_source': forecast_source,
                    'scope_family_tags': scope['scope_family_tags'],
                    'match_type': scope['match_type'],
                    'fallback_level': int(scope['fallback_level']),
                    'actual_sum': actual_sum,
                    'forecast_sum': forecast_sum,
                    'bias': float(bias),
                    'raw_scale': float(raw_scale),
                    'scale_before_guard': round(float(scale_before_guard), 6),
                    'scale': round(scale, 6),
                    'active_months': active_months,
                    'sku_count': int(scope_eval['variant_key'].nunique()),
                    'row_count': int(len(scope_eval)),
                    'actual_weight': float(actual_weight),
                    'month_weight': float(month_weight),
                    'hierarchy_weight': float(hierarchy_weight),
                    'shrinkage_weight': float(shrinkage_weight),
                    'direction_guard': direction,
                    'eligible': bool(eligible),
                }
                artifact['candidate_details'].append(candidate_detail)

                if eligible and selected_rule is None:
                    selected_rule = candidate_detail
                    break

            if selected_rule is None:
                continue

            factor_key = f"{target_family}::{forecast_source}"
            artifact['factors'][factor_key] = {
                'scale': selected_rule['scale'],
                'target_family_tags': target_family,
                'forecast_source': forecast_source,
                'scope_family_tags': selected_rule['scope_family_tags'],
                'match_type': selected_rule['match_type'],
                'fallback_level': selected_rule['fallback_level'],
            }
            artifact['details'].append({
                'factor_key': factor_key,
                **selected_rule,
            })

    return artifact
