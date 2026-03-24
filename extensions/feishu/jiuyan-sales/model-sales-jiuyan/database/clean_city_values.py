#!/usr/bin/env python3
"""
Normalize abnormal city values in the sales SQLite database.

Rules:
1. Clear generic placeholders such as "省直辖县级行政区划".
2. Normalize only explicitly known short-name / legacy aliases.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = REPO_ROOT / "data-base" / "sales_filtered.sqlite"

NULL_CITY_VALUES = {
    "县",
    "市辖区",
    "省直辖县",
    "省直辖县级行政区划",
    "自治区直辖县级行政区划",
}

SHORT_TO_LONG_CITY_VALUES = {
    "临夏州": "临夏回族自治州",
    "乐东县": "乐东黎族自治县",
    "凉山州": "凉山彝族自治州",
    "大理州": "大理白族自治州",
    "德宏州": "德宏傣族景颇族自治州",
    "恩施州": "恩施土家族苗族自治州",
    "文山州": "文山壮族苗族自治州",
    "楚雄州": "楚雄彝族自治州",
    "海东地区": "海东市",
    "海南州": "海南藏族自治州",
    "湘西州": "湘西土家族苗族自治州",
    "白沙县": "白沙黎族自治县",
    "红河州": "红河哈尼族彝族自治州",
    "黔东南州": "黔东南苗族侗族自治州",
    "黔南州": "黔南布依族苗族自治州",
    "黔西南州": "黔西南布依族苗族自治州",
}

def count_distinct_non_empty(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT COUNT(DISTINCT city) FROM sales WHERE TRIM(COALESCE(city, '')) <> ''"
    ).fetchone()
    return int(row[0] or 0)


def count_known_short_names(conn: sqlite3.Connection) -> int:
    placeholders = ", ".join("?" for _ in SHORT_TO_LONG_CITY_VALUES)
    row = conn.execute(
        f"""
        SELECT COUNT(*)
        FROM sales
        WHERE city IN ({placeholders})
        """,
        tuple(sorted(SHORT_TO_LONG_CITY_VALUES)),
    ).fetchone()
    return int(row[0] or 0)


def count_generic_placeholders(conn: sqlite3.Connection) -> int:
    placeholders = ", ".join("?" for _ in NULL_CITY_VALUES)
    row = conn.execute(
        f"""
        SELECT COUNT(*)
        FROM sales
        WHERE city IN ({placeholders})
        """,
        tuple(sorted(NULL_CITY_VALUES)),
    ).fetchone()
    return int(row[0] or 0)


def begin_cleanup(conn: sqlite3.Connection) -> None:
    conn.execute("BEGIN IMMEDIATE")


def rollback_cleanup(conn: sqlite3.Connection) -> None:
    conn.rollback()


def commit_cleanup(conn: sqlite3.Connection) -> None:
    conn.commit()


def apply_cleanup(conn: sqlite3.Connection, dry_run: bool) -> dict[str, int]:
    stats: dict[str, int] = {}

    begin_cleanup(conn)

    placeholders = ", ".join("?" for _ in NULL_CITY_VALUES)
    cursor = conn.execute(
        f"UPDATE sales SET city = '' WHERE city IN ({placeholders})",
        tuple(sorted(NULL_CITY_VALUES)),
    )
    stats["cleared_generic_rows"] = cursor.rowcount

    normalized_short_rows = 0
    for short_name, long_name in SHORT_TO_LONG_CITY_VALUES.items():
        cursor = conn.execute(
            "UPDATE sales SET city = ? WHERE city = ?",
            (long_name, short_name),
        )
        normalized_short_rows += cursor.rowcount
    stats["normalized_short_rows"] = normalized_short_rows

    if dry_run:
        rollback_cleanup(conn)
    else:
        commit_cleanup(conn)

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    conn = sqlite3.connect(args.db)
    try:
        before_distinct = count_distinct_non_empty(conn)
        before_generic = count_generic_placeholders(conn)
        before_short = count_known_short_names(conn)
        stats = apply_cleanup(conn, dry_run=args.dry_run)
        after_distinct = count_distinct_non_empty(conn)
        after_generic = count_generic_placeholders(conn)
        after_short = count_known_short_names(conn)

        print(f"before_distinct_non_empty={before_distinct}")
        print(f"before_generic_rows={before_generic}")
        print(f"before_short_name_rows={before_short}")
        print(f"cleared_generic_rows={stats['cleared_generic_rows']}")
        print(f"normalized_short_rows={stats['normalized_short_rows']}")
        print(f"after_distinct_non_empty={after_distinct}")
        print(f"after_generic_rows={after_generic}")
        print(f"after_short_name_rows={after_short}")
        print(f"dry_run={args.dry_run}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
