import os
import sys
import sqlite3
from pathlib import Path

# Add backend to sys.path to import tagger and db
APP_ROOT = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = APP_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import tagger
from db import DB_PATH

def enrich_sku_data():
    """读取所有 SKU 并使用 tagger 模块更新其家族和变体基因标签。"""
    if not os.path.exists(DB_PATH):
        print(f"Error: Database not found at {DB_PATH}")
        return

    print(f"Using database: {DB_PATH}")
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # 获取所有需要的 SKU 信息
    cursor.execute("SELECT sku_code, sku_name, product_category FROM dim_sku")
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        print("No SKUs found in dim_sku.")
        return

    sku_list = [
        {"barcode": row[0], "product_name": row[1], "product_category": row[2]}
        for row in rows
    ]

    print(f"Enriching genes for {len(sku_list)} SKUs using tagger module...")
    
    # Using tagger's main entry point to handle batch tagging and DB updates
    results = tagger.tag_and_update_new_skus(sku_list)
    
    if results and "new_tags" in results:
        print(f"Found {len(results['new_tags'])} new potential keywords via LLM.")
    
    print("SKU Gene Enrichment Complete.")

if __name__ == "__main__":
    enrich_sku_data()
