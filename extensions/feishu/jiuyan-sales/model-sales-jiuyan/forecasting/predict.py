import os
import sys
import pandas as pd
from forecasting.data_prep import load_sku_monthly_data, fill_missing_months
from forecasting.features import build_features
from forecasting.models.lgbm_model import (
    SKUForecaster,
    ColdStartForecaster,
    apply_focus_family_calibration,
    load_family_calibration_artifact,
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
    print("=== 销售预测生成 (推理模式/分层模型) 开始 ===")
    
    # 1. 检查模型是否存在
    if not os.path.exists(MODEL_TOP_SAVE_PATH) or not os.path.exists(MODEL_TAIL_SAVE_PATH) or not os.path.exists(MODEL_COLD_SAVE_PATH):
        print(f"错误: 未找到模型文件 {MODEL_TOP_SAVE_PATH} 或 {MODEL_TAIL_SAVE_PATH} 或 {MODEL_COLD_SAVE_PATH}")
        print("请先运行 python -m forecasting.train 以训练并保存模型。")
        return

    # 2. 数据加载与清洗
    print("正在加载历史销售数据...")
    df = load_sku_monthly_data()
    df_filled = fill_missing_months(df)
    
    # 3. 加载分层切分的 SKU 列表 (必须由 train.py 产出，严禁动态计算以防路由漂移)
    import json
    from forecasting.config import TOP_SKUS_LIST_PATH, OUTPUT_DIR
    
    # 兼容性逻辑：优先检查新路径 (MODEL_DIR)，兜底检查旧路径 (OUTPUT_DIR)
    final_top_skus_path = TOP_SKUS_LIST_PATH
    if not os.path.exists(final_top_skus_path):
        legacy_path = os.path.join(OUTPUT_DIR, 'top_skus.json')
        if os.path.exists(legacy_path):
            print(f"提示: 在新路径未找到清单，已检测到旧路径产物 {legacy_path}，将自动沿用。")
            final_top_skus_path = legacy_path
        else:
            raise FileNotFoundError(f"致命错误: 未找到 Top SKU 路由清单 {TOP_SKUS_LIST_PATH}。\n"
                                  "原因: 为了保证推理侧与训练侧的模型分流口径完全一致，必须先运行 train.py 生成清单。")
    
    with open(final_top_skus_path, 'r') as f:
        top_skus = json.load(f)
            
    df_top = df_filled[df_filled['variant_key'].astype(str).isin(top_skus)].copy()
    df_tail = df_filled[~df_filled['variant_key'].astype(str).isin(top_skus)].copy()
    
    # 4. 加载双轨模型
    print(f"正在从 {MODEL_TOP_SAVE_PATH} 加载头部模型...")
    forecaster_top = SKUForecaster(mode='top')
    forecaster_top.load(MODEL_TOP_SAVE_PATH)
    
    print(f"正在从 {MODEL_TAIL_SAVE_PATH} 加载长尾模型...")
    forecaster_tail = SKUForecaster(mode='tail')
    forecaster_tail.load(MODEL_TAIL_SAVE_PATH)

    print(f"正在从 {MODEL_COLD_SAVE_PATH} 加载冷启动模型...")
    cold_forecaster = ColdStartForecaster()
    cold_forecaster.load(MODEL_COLD_SAVE_PATH)

    family_calibration_artifact = {}
    if os.path.exists(MODEL_FAMILY_CALIBRATION_PATH):
        family_calibration_artifact = load_family_calibration_artifact(MODEL_FAMILY_CALIBRATION_PATH)
    else:
        print(f"提示: 未找到重点 family 校准产物 {MODEL_FAMILY_CALIBRATION_PATH}，将跳过重点 family 校准。")
    
    # 支持加载未来的业务计划 (如调价方案)
    exog_path = 'data-base/future_exogenous.csv'
    exogenous_df = None
    if os.path.exists(exog_path):
        print(f"检测到外部计划文件: {exog_path}，正在加载...")
        exogenous_df = pd.read_csv(exog_path)
        exogenous_df['date'] = pd.to_datetime(exogenous_df['date'])
    
    # 5. 递归预测未来 12 个月
    print("正在开始未来 12 个月的双轨回归预测...")
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
        df_filled[['variant_key', 'family_tags']],
        family_calibration_artifact,
    )
    forecast_results = forecast_results.drop(columns=['forecast_source'], errors='ignore')
    
    # 6. 保存结果
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, 'forecast_results.csv')
    forecast_results.to_csv(output_path, index=False)
    print(f"预测结果已保存至 {output_path}")
    
    # 7. 生成汇总摘要
    summary = forecast_results.groupby('year_month')['forecast_qty'].sum().reset_index()
    print("\n预测汇总 (总销量):")
    print(summary)
    
    print("=== 销售预测生成 (推理模式) 结束 ===")

if __name__ == '__main__':
    # Ensure current directory is in path
    sys.path.append(os.getcwd())
    main()
