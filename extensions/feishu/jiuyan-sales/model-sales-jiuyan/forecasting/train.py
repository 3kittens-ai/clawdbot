import os
import sys
import pandas as pd
from forecasting.data_prep import load_sku_monthly_data, fill_missing_months
from forecasting.features import build_features
from forecasting.models.lgbm_model import (
    SKUForecaster,
    ColdStartForecaster,
    apply_focus_family_calibration,
    learn_focus_family_calibration_artifact,
    save_family_calibration_artifact,
)
from forecasting.config import (
    OUTPUT_DIR,
    MODEL_TOP_SAVE_PATH,
    MODEL_TAIL_SAVE_PATH,
    MODEL_COLD_SAVE_PATH,
    MODEL_FAMILY_CALIBRATION_PATH,
    TOP_SKU_THRESHOLD,
)

def main():
    print("=== 销售预测流水线开始 (分层建模) ===")
    
    # 1. 数据加载与清洗
    df = load_sku_monthly_data()
    df_filled = fill_missing_months(df)
    max_date = df_filled['date'].max()
    
    import json
    from forecasting.config import TOP_SKUS_LIST_PATH
    
    # 2. 分层切分数据集
    sku_volumes = df_filled.groupby('variant_key')['monthly_qty'].sum().sort_values(ascending=False)
    top_skus = sku_volumes.head(TOP_SKU_THRESHOLD).index.fillna("").astype(str).tolist()
    
    os.makedirs(os.path.dirname(TOP_SKUS_LIST_PATH), exist_ok=True)
    with open(TOP_SKUS_LIST_PATH, 'w') as f:
        json.dump(top_skus, f)
    print(f"Top SKU 列表已保存至 {TOP_SKUS_LIST_PATH}")
    
    df_top = df_filled[df_filled['variant_key'].astype(str).isin(top_skus)].copy()
    df_tail = df_filled[~df_filled['variant_key'].astype(str).isin(top_skus)].copy()
    
    # 取出纯历史数据用于训练
    train_top = df_top[df_top['date'] <= max_date]
    train_tail = df_tail[df_tail['date'] <= max_date]
    
    # 3. 模型训练
    print(f"[{len(top_skus)} Top SKUs] 正在训练头部趋势模型...")
    forecaster_top = SKUForecaster(mode='top')
    forecaster_top.train(train_top)
    forecaster_top.save(MODEL_TOP_SAVE_PATH)
    
    print(f"[{train_tail['variant_key'].nunique()} Tail SKUs] 正在训练长尾家族模型...")
    forecaster_tail = SKUForecaster(mode='tail')
    forecaster_tail.train(train_tail)
    forecaster_tail.save(MODEL_TAIL_SAVE_PATH)

    print(f"[{train_top['variant_key'].nunique() + train_tail['variant_key'].nunique()} SKUs] 正在训练冷启动模型...")
    cold_forecaster = ColdStartForecaster()
    cold_forecaster.train(df_filled)
    cold_forecaster.save(MODEL_COLD_SAVE_PATH)

    print("正在学习重点 family 白名单校准产物...")
    family_calibration_artifact = learn_focus_family_calibration_artifact(df_filled)
    save_family_calibration_artifact(family_calibration_artifact, MODEL_FAMILY_CALIBRATION_PATH)
    
    # 4. 递归预测未来 12 个月
    print("正在开始未来 12 个月的双轨回归预测...")
    exog_path = 'data-base/future_exogenous.csv'
    exogenous_df = None
    if os.path.exists(exog_path):
        print(f"检测到外部计划文件: {exog_path}，正在加载...")
        exogenous_df = pd.read_csv(exog_path)
        exogenous_df['date'] = pd.to_datetime(exogenous_df['date'])
    
    print("=> 预测头部 SKU")
    forecast_results_top = forecaster_top.predict_recursive(df_top, steps=12, exogenous_df=exogenous_df, candidate_df=df_top)
    forecast_results_top['forecast_source'] = 'seen'
    
    print("=> 预测长尾 SKU")
    forecast_results_tail = forecaster_tail.predict_recursive(df_tail, steps=12, exogenous_df=exogenous_df, candidate_df=df_tail)
    forecast_results_tail['forecast_source'] = 'seen'

    print("=> 预测冷启动 SKU")
    forecast_results_cold = cold_forecaster.predict_new_variants(
        df_filled,
        df_filled,
        steps=12,
        exogenous_df=exogenous_df
    )
    forecast_results_cold['forecast_source'] = 'cold'
    
    # 合并预测结果
    forecast_results = pd.concat([forecast_results_top, forecast_results_tail, forecast_results_cold], ignore_index=True)
    forecast_results = apply_focus_family_calibration(
        forecast_results,
        df_filled[['variant_key', 'family_tags']].drop_duplicates(),
        family_calibration_artifact,
    )
    forecast_results = forecast_results.drop(columns=['forecast_source'], errors='ignore')
    
    # 5. 保存结果
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, 'forecast_results.csv')
    forecast_results.to_csv(output_path, index=False)
    print(f"预测结果已保存至 {output_path}")
    
    # 6. 生成汇总摘要
    summary = forecast_results.groupby('year_month')['forecast_qty'].sum().reset_index()
    print("\n预测汇总 (总销量):")
    print(summary)
    
    print("=== 销售预测流水线结束 ===")

if __name__ == '__main__':
    # Ensure current directory is in path
    sys.path.append(os.getcwd())
    main()
