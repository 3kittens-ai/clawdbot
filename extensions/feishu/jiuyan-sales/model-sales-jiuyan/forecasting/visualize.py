import pandas as pd
import matplotlib.pyplot as plt
import os
import sqlite3
from forecasting.config import OUTPUT_DIR, CHART_DIR, DB_PATH

# 设置中文字体（Mac 常用字体）
plt.rcParams['font.sans-serif'] = ['Arial Unicode MS', 'Heiti TC', 'SimHei', 'sans-serif']
plt.rcParams['axes.unicode_minus'] = False # 解决负号显示问题

def plot_total_forecast():
    """绘制总历史销售额与总预测额的对比图。"""
    # 1. 加载预测结果
    forecast_path = os.path.join(OUTPUT_DIR, 'forecast_results.csv')
    if not os.path.exists(forecast_path):
        print("Forecast results not found.")
        return
    df_f = pd.read_csv(forecast_path)
    df_f_sum = df_f.groupby('year_month')['forecast_qty'].sum().reset_index()
    df_f_sum['date'] = pd.to_datetime(df_f_sum['year_month'] + '-01')
    
    # 2. 加载历史数据
    from forecasting.data_prep import load_sku_monthly_data
    df_h_all = load_sku_monthly_data()
    # 汇总到总计级别
    df_h_sum = df_h_all.groupby('year_month')['monthly_qty'].sum().reset_index()
    df_h_sum['date'] = pd.to_datetime(df_h_sum['year_month'] + '-01')
    
    # 3. 绘图
    plt.figure(figsize=(14, 7))
    plt.plot(df_h_sum['date'], df_h_sum['monthly_qty'], label='历史销量', marker='o', color='blue')
    plt.plot(df_f_sum['date'], df_f_sum['forecast_qty'], label='预测销量', marker='x', linestyle='--', color='red')
    
    start_m = df_f_sum['year_month'].min()
    end_m = df_f_sum['year_month'].max()
    plt.title(f'总销量预测 ({start_m} 至 {end_m})')
    plt.xlabel('月份')
    plt.ylabel('销量')
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    os.makedirs(CHART_DIR, exist_ok=True)
    save_path = os.path.join(CHART_DIR, 'total_forecast_trend.png')
    plt.savefig(save_path)
    print(f"图表已保存至 {save_path}")

if __name__ == '__main__':
    plot_total_forecast()
