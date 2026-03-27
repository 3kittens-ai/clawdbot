#!/usr/bin/env python3
import sqlite3
import sys
import os
from pathlib import Path

# Add BASE_DIR to sys.path
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from forecasting.config import DB_PATH
from forecasting.rebuild_family_tags import rebuild_family, write_families_markdown
from forecasting.utils.tag_extractor import load_keywords, extract_tags_from_name
from scripts.sales_import_job import (
    extract_spec_length, extract_spec_hook, extract_spec_qty, extract_spec_size,
    derive_product_root, build_variant_key, refresh_variations_doc
)

TAGS_DOC_PATH = BASE_DIR / "docs" / "tags.md"
FAMILIES_DOC_PATH = BASE_DIR / "docs" / "families.md"
VARIATIONS_DOC_PATH = BASE_DIR / "docs" / "variations.md"

def rebuild_metadata():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    
    print(f"Connecting to database: {DB_PATH}")
    
    # 1. Load keywords from local tags.md
    keyword_list = load_keywords(str(TAGS_DOC_PATH))
    
    # 2. Fetch all SKUs currently in dimension table
    skus = conn.execute("SELECT sku_code, sku_name, product_category, family_tags FROM dim_sku").fetchall()
    print(f"Total SKUs to refresh: {len(skus)}")
    
    dim_updates = []
    sku_tag_rows = []
    
    for row in skus:
        sku_code = row["sku_code"]
        sku_name = row["sku_name"] or ""
        product_category = row["product_category"] or ""
        
        # Re-parse family tags using latest rules in rebuild_family_tags.py
        family_tags = rebuild_family(product_category, sku_name)
        
        # Re-parse specs using latest regex in sales_import_job.py
        spec_length = extract_spec_length(sku_name)
        spec_hook = extract_spec_hook(sku_name)
        spec_qty = extract_spec_qty(sku_name)
        spec_size = extract_spec_size(sku_name, spec_hook)
        
        # Re-parse business tags
        business_tags = extract_tags_from_name(sku_name, keyword_list)
        
        # Re-parse variant key (composite SKU identifier)
        family_segments = [s for s in family_tags.split("|") if s and s != product_category]
        product_root = derive_product_root(product_category, family_segments, business_tags)
        variant_key = build_variant_key(product_root, spec_length, spec_size, spec_hook, spec_qty)
        
        dim_updates.append((
            sku_name, product_category, spec_length or None, spec_size or None, 
            spec_hook or None, spec_qty or None, family_tags, variant_key, sku_code
        ))
        
        # Build sku_tags rows (flat table for fast lookup)
        merged_tags = []
        for tag in [*business_tags, *family_segments]:
            if tag and tag not in merged_tags and tag != product_category:
                merged_tags.append(tag)
        for tag in [spec_length, spec_size, spec_hook, spec_qty]:
            if tag and tag not in merged_tags:
                merged_tags.append(tag)
        for tag_name in merged_tags:
            sku_tag_rows.append((sku_code, tag_name))

    # 3. Apply updates to dim_sku
    print("Updating dim_sku...")
    conn.executemany("""
        UPDATE dim_sku SET
            sku_name = ?,
            product_category = ?,
            spec_length = ?,
            spec_size = ?,
            spec_hook = ?,
            spec_qty = ?,
            family_tags = ?,
            variant_key = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE sku_code = ?
    """, dim_updates)
    
    # 4. Rebuild sku_tags (TRUNCATE then INSERT)
    print("Rebuilding sku_tags table...")
    conn.execute("DELETE FROM sku_tags")
    conn.executemany("INSERT OR IGNORE INTO sku_tags (sku_code, tag_name) VALUES (?, ?)", sku_tag_rows)
    
    conn.commit()
    
    # 5. Refresh Documentation
    print("Refreshing documentation...")
    # Update variations.md with latest frequencies
    refresh_variations_doc(conn, VARIATIONS_DOC_PATH)
    
    # Re-generate families.md using the list of changes
    rows_for_doc = []
    for update in dim_updates:
        rows_for_doc.append({
            "sku_code": update[8],
            "sku_name": update[0],
            "product_category": update[1],
            "new_family_tags": update[6]
        })
    write_families_markdown(rows_for_doc, FAMILIES_DOC_PATH)
    
    conn.close()
    print("Database metadata refresh complete.")

if __name__ == "__main__":
    try:
        rebuild_metadata()
    except Exception as e:
        print(f"Error during metadata rebuild: {e}")
        sys.exit(1)
