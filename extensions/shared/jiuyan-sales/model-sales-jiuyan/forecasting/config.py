import os

def resolve_db_path() -> str:
    env_override = os.environ.get("OPENCLAW_JIUYAN_SALES_DB_PATH")
    if env_override:
        return env_override

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    direct_path = os.path.join(base_dir, 'data-base', 'sales_filtered.sqlite')
    if os.path.exists(direct_path):
        return direct_path

    current = base_dir
    for _ in range(8):
        candidate = os.path.join(
            current,
            'extensions',
            'shared',
            'jiuyan-sales',
            'model-sales-jiuyan',
            'data-base',
            'sales_filtered.sqlite',
        )
        if os.path.exists(candidate):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return direct_path

# 项目路径
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = resolve_db_path()
OUTPUT_DIR = os.path.join(BASE_DIR, 'outputs')
CHART_DIR = os.path.join(OUTPUT_DIR, 'charts')
MODEL_DIR = os.path.join(BASE_DIR, 'forecasting', 'models', 'saved')
MODEL_SAVE_PATH = os.path.join(MODEL_DIR, 'sku_forecaster.lgb')
MODEL_TOP_SAVE_PATH = os.path.join(MODEL_DIR, 'sku_forecaster_top.lgb')
MODEL_TAIL_SAVE_PATH = os.path.join(MODEL_DIR, 'sku_forecaster_tail.lgb')
MODEL_COLD_SAVE_PATH = os.path.join(MODEL_DIR, 'sku_forecaster_cold.lgb')
MODEL_FAMILY_CALIBRATION_PATH = os.path.join(MODEL_DIR, 'family_calibration.json')
FAMILY_CALIBRATION_EVAL_PATH = os.path.join(OUTPUT_DIR, 'family_calibration_eval.json')
FOCUS_FAMILY_CALIBRATION_WHITELIST = [
    '线组|鲢鳙|普通',
    '无结子线|新关东|鲢鳙|护线绳',
    '线组|全飞铅|翘草鳊',
    '线组|黑坑|偷驴',
    '线组|黑坑|飞磕',
]
FOCUS_FAMILY_CALIBRATION_WINDOW_MONTHS = 12
FOCUS_FAMILY_CALIBRATION_MIN_ACTUAL_SUM = 10000
FOCUS_FAMILY_CALIBRATION_MIN_ACTIVE_MONTHS = 2
FOCUS_FAMILY_CALIBRATION_MIN_ABS_BIAS = 0.15
FOCUS_FAMILY_CALIBRATION_SHRINK_ACTUAL_REF = 80000
FOCUS_FAMILY_CALIBRATION_SHRINK_MONTH_REF = 6
FOCUS_FAMILY_CALIBRATION_PARENT_DECAY = 0.85
FOCUS_FAMILY_CALIBRATION_SCOPE_OVERRIDES = {
    '线组|鲢鳙|普通': ['线组|鲢鳙|普通', '线组|鲢鳙'],
    '无结子线|新关东|鲢鳙|护线绳': ['无结子线|新关东|鲢鳙|护线绳', '无结子线|新关东|鲢鳙', '无结子线|新关东'],
    '线组|全飞铅|翘草鳊': ['线组|全飞铅|翘草鳊', '线组|全飞铅'],
    '线组|黑坑|偷驴': ['线组|黑坑|偷驴', '线组|黑坑'],
    '线组|黑坑|飞磕': ['线组|黑坑|飞磕', '线组|黑坑'],
}
FOCUS_FAMILY_CALIBRATION_DIRECTION = {
    '线组|鲢鳙|普通': 'up',
    '无结子线|新关东|鲢鳙|护线绳': 'up',
    '线组|全飞铅|翘草鳊': 'up',
    '线组|黑坑|偷驴': 'down',
    '线组|黑坑|飞磕': 'down',
}
FAMILY_CALIBRATION_WINDOW_MONTHS = 6
FAMILY_CALIBRATION_MAX_FAMILIES = 5
FAMILY_CALIBRATION_MIN_ACTUAL_SUM = 20000
FAMILY_CALIBRATION_MIN_ABS_BIAS = 0.25
FAMILY_CALIBRATION_MIN_SCALE = 0.5
FAMILY_CALIBRATION_MAX_SCALE = 3.0
FAMILY_CALIBRATION_PRIORITY_FAMILIES = [
    '线组|鲢鳙|普通',
    '无结子线|新关东|鲢鳙|护线绳',
    '线组|全飞铅|翘草鳊',
    '线组|黑坑|偷驴',
    '线组|黑坑|飞磕',
]

# 分层模型参数
TOP_SKU_THRESHOLD = 300  # 使用 Top 多少个 SKU 作为趋势组
TOP_SKUS_LIST_PATH = os.path.join(MODEL_DIR, 'top_skus.json')

# 预测参数
FORECAST_START_MONTH = '2026-03'
FORECAST_HORIZON = 12  # 预测步长（月）

# 春节日期 (CNY)
# 2021: Feb 12
# 2022: Feb 1
# 2023: Jan 22
# 2024: Feb 10
# 2025: Jan 29
# 2026: Feb 17
# 2027: Feb 6
CNY_DATES = {
    2021: '2021-02-12',
    2022: '2022-02-01',
    2023: '2023-01-22',
    2024: '2024-02-10',
    2025: '2025-01-29',
    2026: '2026-02-17',
    2027: '2027-02-06'
}

# 中秋节 (农历八月十五)
MID_AUTUMN_DATES = {
    2021: '2021-09-21',
    2022: '2022-09-10',
    2023: '2023-09-29',
    2024: '2024-09-17',
    2025: '2025-10-06',
    2026: '2026-09-25',
    2027: '2027-09-15'
}

# 端午节 (农历五月初五)
DRAGON_BOAT_DATES = {
    2021: '2021-06-14',
    2022: '2022-06-03',
    2023: '2023-06-22',
    2024: '2024-06-10',
    2025: '2025-05-31',
    2026: '2026-06-19',
    2027: '2027-06-11'
}

# 电商大促月份 (6: 618, 11: 双11, 12: 双12)
PROMO_MONTHS = [6, 11, 12]

# LGBM 超参数 (基准值)
LGBM_PARAMS = {
    'objective': 'regression',
    'metric': 'rmse',
    'verbosity': -1,
    'boosting_type': 'gbdt',
    'random_state': 42,
    'learning_rate': 0.05,
    'num_leaves': 31,
    'feature_fraction': 0.8,
    'bagging_fraction': 0.8,
    'bagging_freq': 5,
}

# 特征工程参数
LAG_MONTHS = [1, 2, 3, 6, 12]
ROLLING_WINDOWS = [3, 6, 12]
