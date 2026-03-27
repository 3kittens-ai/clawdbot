#!/usr/bin/env python3
import sqlite3
import pandas as pd
import sys
import os
from pathlib import Path

# Add BASE_DIR to sys.path
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from forecasting.config import DB_PATH

def import_inventory(excel_path: str):
    print(f"Reading inventory data from: {excel_path}")
    df = pd.read_excel(excel_path)
    
    # Map columns
    column_map = {
        "商品编码": "sku_code",
        "实际可用数": "latest_inventory",
        "采购在途": "latest_in_transit"
    }
    
    # Check if required columns exist
    for col in column_map.keys():
        if col not in df.columns:
            print(f"Warning: Required column '{col}' not found in Excel. Skipping.")
            return

    # Prepare data
    data = df[list(column_map.keys())].copy()
    data.columns = [column_map[col] for col in data.columns]
    data["sku_code"] = data["sku_code"].astype(str).str.strip()
    
    # Connect and ensure columns exist
    conn = sqlite3.connect(DB_PATH)
    try:
        existing_columns = {row[1] for row in conn.execute("PRAGMA table_info(dim_sku)").fetchall()}
        if "latest_inventory" not in existing_columns:
            print("Adding column 'latest_inventory' to dim_sku")
            conn.execute("ALTER TABLE dim_sku ADD COLUMN latest_inventory INTEGER")
        if "latest_in_transit" not in existing_columns:
            print("Adding column 'latest_in_transit' to dim_sku")
            conn.execute("ALTER TABLE dim_sku ADD COLUMN latest_in_transit INTEGER")
            
        print(f"Updating inventory for {len(data)} SKUs...")
        # Use a list of tuples for executemany
        update_rows = []
        for _, row in data.iterrows():
            inv = int(row.latest_inventory) if not pd.isna(row.latest_inventory) else None
            trans = int(row.latest_in_transit) if not pd.isna(row.latest_in_transit) else None
            if inv is not None or trans is not None:
                update_rows.append((inv, trans, row.sku_code))
        
        conn.executemany("""
            UPDATE dim_sku SET 
                latest_inventory = ?, 
                latest_in_transit = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE sku_code = ?
        """, update_rows)
        
        conn.commit()
        print(f"Successfully updated inventory for {len(update_rows)} SKUs.")
    finally:
        conn.close()

if __name__ == "__main__":
    # Find the latest product archive file
    archive_dir = BASE_DIR / "outputs" / "formula"
    files = list(archive_dir.glob("*商品主题分析_全商品档案*"))
    if not files:
        print("Error: Could not find any product archive Excel file.")
        sys.exit(1)
    
    # Sort by mtime to get the latest
    files.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    latest_file = str(files[0])
    
    import_inventory(latest_file)
