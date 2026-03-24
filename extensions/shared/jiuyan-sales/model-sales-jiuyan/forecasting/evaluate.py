import pandas as pd
import numpy as np
import os
import sys
from forecasting.data_prep import load_sku_monthly_data, fill_missing_months
from forecasting.models.lgbm_model import (
    SKUForecaster,
    ColdStartForecaster,
    apply_focus_family_calibration,
    learn_focus_family_calibration_artifact,
    save_family_calibration_artifact,
)
from forecasting.config import OUTPUT_DIR, TOP_SKU_THRESHOLD, FAMILY_CALIBRATION_EVAL_PATH

def calculate_wape(actual: pd.Series, forecast: pd.Series) -> float:
    """加权平均百分比误差 (WAPE)。缺失的预测值将按 0 计算误差。"""
    # 填充 NaN 为 0，确保新 SKU 的未预测部分计入误差
    forecast_filled = forecast.fillna(0)
    
    abs_err = (actual - forecast_filled).abs().sum()
    sum_actual = actual.sum()
    
    if sum_actual == 0:
        return 0.0
    return abs_err / sum_actual

def main():
    print("=== 模型回测与评估开始 (分层建模) ===")
    
    # 1. 数据加载与清洗
    df = load_sku_monthly_data()
    df_filled = fill_missing_months(df)
    
    # 2. 回测数据集切分
    max_date = df_filled['date'].max()
    eval_start_date = max_date - pd.DateOffset(months=11) # 回测 12 个月
    anchor_cutoff = eval_start_date.strftime('%Y-%m')
    
    print(f"正在切分回测数据 (训练集: < {anchor_cutoff})...")
    
    train_df_full = df_filled[df_filled['date'] < eval_start_date]
    sku_volumes = train_df_full.groupby('variant_key')['monthly_qty'].sum().sort_values(ascending=False)
    top_skus = sku_volumes.head(TOP_SKU_THRESHOLD).index.fillna("").astype(str).tolist()
    
    df_top = df_filled[df_filled['variant_key'].astype(str).isin(top_skus)].copy()
    df_tail = df_filled[~df_filled['variant_key'].astype(str).isin(top_skus)].copy()
    
    train_top = df_top[df_top['date'] < eval_start_date]
    train_tail = df_tail[df_tail['date'] < eval_start_date]
    actual_test_df = df_filled[(df_filled['date'] >= eval_start_date) & (df_filled['date'] <= max_date)]
    
    # 4. 训练模型
    print(f"[{len(top_skus)} Top SKUs] 正在训练头部趋势模型...")
    forecaster_top = SKUForecaster(mode='top')
    forecaster_top.train(train_top)
    
    print(f"[{train_tail['variant_key'].nunique()} Tail SKUs] 正在训练长尾家族模型...")
    forecaster_tail = SKUForecaster(mode='tail')
    forecaster_tail.train(train_tail)

    print("正在训练冷启动模型...")
    cold_forecaster = ColdStartForecaster()
    cold_forecaster.train(train_df_full, anchor_cutoff=anchor_cutoff)

    print("正在学习重点 family 白名单校准产物...")
    family_calibration_artifact = learn_focus_family_calibration_artifact(train_df_full)
    save_family_calibration_artifact(family_calibration_artifact, FAMILY_CALIBRATION_EVAL_PATH)
    # 6. 为验证年份执行递归预测

    print(f"正在递归预测 {anchor_cutoff} 到 {max_date.strftime('%Y-%m')}...")
    seed_top = df_top[df_top['date'] < eval_start_date].copy()
    backtest_forecast_top = forecaster_top.predict_recursive(seed_top, steps=12, anchor_cutoff=anchor_cutoff, candidate_df=train_top)
    backtest_forecast_top['forecast_source'] = 'seen'
    
    seed_tail = df_tail[df_tail['date'] < eval_start_date].copy()
    backtest_forecast_tail = forecaster_tail.predict_recursive(seed_tail, steps=12, anchor_cutoff=anchor_cutoff, candidate_df=train_tail)
    backtest_forecast_tail['forecast_source'] = 'seen'
    backtest_forecast_cold = cold_forecaster.predict_new_variants(
        train_df_full,
        actual_test_df,
        steps=12,
        anchor_cutoff=anchor_cutoff
    )
    backtest_forecast_cold['forecast_source'] = 'cold'
    
    backtest_forecast = pd.concat([backtest_forecast_top, backtest_forecast_tail, backtest_forecast_cold], ignore_index=True)
    backtest_forecast = apply_focus_family_calibration(
        backtest_forecast,
        df_filled[['variant_key', 'family_tags']].drop_duplicates(),
        family_calibration_artifact,
    )
    
    # 7. 计算评估详情
    eval_df = pd.merge(
        actual_test_df[['variant_key', 'family_tags', 'year_month', 'monthly_qty', 'product_category', 'date', 'main_channel', 'top_province']],
        backtest_forecast[['variant_key', 'year_month', 'forecast_qty']],
        on=['variant_key', 'year_month'],
        how='left'
    )
    eval_df['forecast_qty'] = eval_df['forecast_qty'].fillna(0)
    
    # 计算 horizon (步长)
    eval_df['horizon'] = ((pd.to_datetime(eval_df['date']).dt.year - eval_start_date.year) * 12 + 
                          pd.to_datetime(eval_df['date']).dt.month - eval_start_date.month + 1)
    
    # 8. 计算各级指标
    def get_metrics(df):
        actuals = df['monthly_qty']
        forecasts = df['forecast_qty']
        diff = forecasts - actuals
        abs_diff = diff.abs()
        
        sku_count = df['variant_key'].nunique()
        row_count = len(df)
        actual_sum = actuals.sum()
        forecast_sum = forecasts.sum()
        
        wape = abs_diff.sum() / actual_sum if actual_sum > 0 else 0
        mae = abs_diff.mean()
        mape = (abs_diff / actuals.replace(0, np.nan)).mean()
        rmse = np.sqrt((diff**2).mean())
        bias = (forecast_sum - actual_sum) / actual_sum if actual_sum > 0 else 0
        
        return pd.Series({
            'sku_count': sku_count,
            'row_count': row_count,
            'actual_sum': actual_sum,
            'forecast_sum': forecast_sum,
            'wape': wape,
            'mae': mae,
            'mape': mape,
            'rmse': rmse,
            'bias': bias
        })

    print("计算整体指标...")
    global_metrics = get_metrics(eval_df).to_frame().T
    global_metrics.insert(0, 'model_target', 'raw')
    
    print("计算分步指标...")
    horizon_metrics = eval_df.groupby('horizon').apply(get_metrics).reset_index()
    horizon_metrics.insert(0, 'model_target', 'raw')
    horizon_metrics.rename(columns={'horizon': 'forecast_horizon(month)'}, inplace=True)
    
    print("计算品类指标...")
    category_metrics = eval_df.groupby('product_category', observed=False).apply(get_metrics).reset_index()
    category_metrics.sort_values('actual_sum', ascending=False, inplace=True)
    
    print("计算业务家族指标...")
    family_metrics = eval_df.groupby('family_tags', observed=False).apply(get_metrics).reset_index()
    family_metrics.sort_values('actual_sum', ascending=False, inplace=True)
    
    print("计算 Top 100 SKU 指标...")
    # 先聚合找出历史销量最大的 100 个 variant_key
    top_variant_keys = eval_df.groupby('variant_key')['monthly_qty'].sum().nlargest(100).index
    top_sku_metrics = eval_df[eval_df['variant_key'].isin(top_variant_keys)].groupby('variant_key').apply(get_metrics).reset_index()
    top_sku_metrics.sort_values('actual_sum', ascending=False, inplace=True)

    print("计算渠道指标...")
    channel_metrics = eval_df.groupby('main_channel', observed=False).apply(get_metrics).reset_index()
    channel_metrics.sort_values('actual_sum', ascending=False, inplace=True)

    print("计算地域指标...")
    province_metrics = eval_df.groupby('top_province', observed=False).apply(get_metrics).reset_index()
    province_metrics.sort_values('actual_sum', ascending=False, inplace=True)
    
    # 9. 提取特征重要性
    print("提取特征重要性...")
    def get_feat_imp(model):
        imp = pd.DataFrame({
            'feature_name': model.feature_name(),
            'importance': model.feature_importance(importance_type='gain')
        }).sort_values('importance', ascending=False)
        imp.insert(0, 'rank', range(1, len(imp) + 1))
        return imp
        
    feat_imp_top = get_feat_imp(forecaster_top.model)
    feat_imp_tail = get_feat_imp(forecaster_tail.model)
    
    # 10. 保存结果
    eval_path = os.path.join(OUTPUT_DIR, 'backtest_eval.csv')
    global_path = os.path.join(OUTPUT_DIR, 'metrics_global.csv')
    horizon_path = os.path.join(OUTPUT_DIR, 'metrics_horizon.csv')
    category_path = os.path.join(OUTPUT_DIR, 'metrics_by_category.csv')
    family_path = os.path.join(OUTPUT_DIR, 'metrics_by_family.csv')
    channel_path = os.path.join(OUTPUT_DIR, 'metrics_by_channel.csv')
    province_path = os.path.join(OUTPUT_DIR, 'metrics_by_province.csv')
    top_sku_path = os.path.join(OUTPUT_DIR, 'metrics_top_skus.csv')
    importance_top_path = os.path.join(OUTPUT_DIR, 'feature_importance_top.csv')
    importance_tail_path = os.path.join(OUTPUT_DIR, 'feature_importance_tail.csv')
    
    eval_df.to_csv(eval_path, index=False)
    global_metrics.to_csv(global_path, index=False)
    horizon_metrics.to_csv(horizon_path, index=False)
    category_metrics.to_csv(category_path, index=False)
    family_metrics.to_csv(family_path, index=False)
    channel_metrics.to_csv(channel_path, index=False)
    province_metrics.to_csv(province_path, index=False)
    top_sku_metrics.to_csv(top_sku_path, index=False)
    feat_imp_top.to_csv(importance_top_path, index=False)
    feat_imp_tail.to_csv(importance_tail_path, index=False)
    
    print(f"\n评估详情已保存至 {OUTPUT_DIR}")
    print(f"family 自动校准产物已保存至 {FAMILY_CALIBRATION_EVAL_PATH}")
    print("=== 评估结束 ===")

if __name__ == '__main__':
    sys.path.append(os.getcwd())
    main()
