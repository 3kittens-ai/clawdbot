from __future__ import annotations

import argparse
import csv
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Iterable

from forecasting.config import BASE_DIR, DB_PATH, OUTPUT_DIR


MAX_FAMILY_SEGMENTS = 4
FAMILIES_DOC_PATH = Path(BASE_DIR) / "docs" / "families.md"
CHANGES_CSV_PATH = Path(OUTPUT_DIR) / "family_rebuild_changes.csv"
SUMMARY_CSV_PATH = Path(OUTPUT_DIR) / "family_rebuild_summary.csv"


HOOK_RULES = [
    ("改良海夕", ("改良海夕",)),
    ("金海夕", ("金海夕",)),
    ("海夕", ("海夕",)),
    ("新关东", ("新关东",)),
    ("关东", ("关东",)),
    ("伊势尼", ("伊势尼",)),
    ("伊豆", ("伊豆",)),
    ("金袖", ("金袖",)),
    ("赤袖", ("赤袖",)),
    ("白袖", ("白袖",)),
    ("黑袖", ("黑袖",)),
    ("袖", ("袖",)),
    ("丸世", ("丸世",)),
    ("秋田狐", ("秋田狐",)),
    ("千又", ("千又",)),
    ("溪流", ("溪流",)),
    ("岩牙", ("岩牙",)),
    ("罗非", ("罗非",)),
    ("黄尾", ("黄尾",)),
    ("飞得罗", ("飞得罗",)),
    ("朝天钩", ("朝天钩",)),
]


LINE_CORE_RULES = [
    ("七星漂", ("七星漂",)),
    ("黑坑", ("黑坑",)),
    ("鲢鳙", ("鲢鳙",)),
    ("罗非", ("罗非",)),
    ("黄尾", ("黄尾",)),
    ("巨物", ("巨物", "大物")),
    ("全飞铅", ("全飞铅",)),
    ("闷杆", ("闷杆",)),
    ("滑漂", ("滑漂",)),
    ("双无结", ("GT双无结", "双无结")),
    ("全无结", ("全无结",)),
    ("尤尼吉可", ("尤尼吉可",)),
    ("岩顶", ("岩顶",)),
    ("溪流", ("溪流",)),
    ("草鱼", ("草鱼",)),
    ("子线夹", ("子线夹",)),
    ("强力", ("PE双芯", "PE加固", "极配", "大力马", "防爆", "强力")),
    ("双铅", ("双铅",)),
    ("鲫鱼", ("鲫鱼",)),
]


def normalize_name(name: str | None) -> str:
    text = (name or "").strip()
    replacements = {
        "（": "(",
        "）": ")",
        "【": "[",
        "】": "]",
        "；": ";",
        "，": ",",
        "　": "",
        " ": "",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text


def has_any(text: str, patterns: Iterable[str]) -> bool:
    return any(pattern in text for pattern in patterns)


def first_match(text: str, rules: list[tuple[str, tuple[str, ...]]]) -> str | None:
    for label, patterns in rules:
        if has_any(text, patterns):
            return label
    return None


def detect_hook(text: str) -> str | None:
    return first_match(text, HOOK_RULES)


def append_unique(tokens: list[str], value: str | None) -> None:
    if value and value not in tokens:
        tokens.append(value)


def extend_priority(tokens: list[str], values: Iterable[str], max_segments: int = MAX_FAMILY_SEGMENTS) -> list[str]:
    for value in values:
        if len(tokens) >= max_segments:
            break
        append_unique(tokens, value)
    return tokens


def cleanup_tokens(tokens: list[str]) -> list[str]:
    cleaned: list[str] = []
    for token in tokens:
        token = token.strip("| ").replace("线组线组", "线组")
        if token and token not in cleaned:
            cleaned.append(token)
    return cleaned[:MAX_FAMILY_SEGMENTS]


def build_line_group_family(name: str) -> str:
    tokens = ["线组"]
    core = first_match(name, LINE_CORE_RULES) or "通用"
    append_unique(tokens, core)

    if core == "七星漂":
        modifiers: list[str] = []
        if has_any(name, ("铜头", "朝天钩")):
            modifiers.append("铜头朝天钩")
        elif "八字环" in name:
            modifiers.append("八字环")
        elif "全无结" in name:
            modifiers.append("全无结")
        hook = detect_hook(name)
        if hook and hook not in {"朝天钩"}:
            modifiers.append(hook)
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "黑坑":
        modifiers: list[str] = []
        if "全无结" in name:
            modifiers.append("全无结")
        for tag in ("偷驴", "飞磕", "正钓", "竞技"):
            if tag in name:
                modifiers.append(tag)
                break
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "鲢鳙":
        modifiers = ["活铅" if "活铅" in name else "普通"]
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "罗非":
        modifiers = []
        if "高速八字环" in name:
            modifiers.append("高速八字环")
        elif "八字环" in name:
            modifiers.append("八字环")
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "巨物":
        modifiers = []
        if "成品滑漂" in name:
            modifiers.append("成品滑漂")
        if "PE" in name:
            modifiers.append("PE")
        elif "防爆" in name:
            modifiers.append("防爆")
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "双无结":
        modifiers = ["GT"] if "GT" in name else []
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "全飞铅":
        modifiers = ["翘草鳊"] if "翘草鳊" in name else []
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "全无结":
        modifiers = ["鲫鱼" if "鲫鱼" in name else "通用"]
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "岩顶":
        modifiers = ["原丝"] if "原丝" in name else []
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "溪流":
        modifiers = ["灵敏"] if "灵敏" in name else []
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "草鱼":
        modifiers = []
        if "单钩" in name:
            modifiers.append("单钩")
        if "通线" in name:
            modifiers.append("通线")
        elif "子线组" in name:
            modifiers.append("子线")
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "子线夹":
        modifiers = []
        if "PE双芯" in name or "极配" in name:
            modifiers.append("PE双芯极配")
        elif "PE加固" in name:
            modifiers.append("PE加固")
        elif "大力马" in name:
            modifiers.append("大力马")
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "强力":
        modifiers = []
        if "PE双芯" in name or "极配" in name:
            modifiers.append("PE双芯极配")
        elif "PE加固" in name:
            modifiers.append("PE加固")
        elif "大力马" in name:
            modifiers.append("大力马")
        elif "防爆" in name:
            modifiers.append("防爆")
        if "飞磕" in name:
            modifiers.append("飞磕")
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    return "|".join(cleanup_tokens(tokens))


def build_no_knot_family(name: str) -> str:
    tokens = ["无结子线"]
    core = detect_hook(name) or "通用"
    append_unique(tokens, core)

    modifiers: list[str] = []
    priority_rules = [
        ("鲢鳙", ("鲢鳙",)),
        ("护线绳", ("护线绳",)),
        ("加长", ("无结加长", "加长子线", "加长")),
        ("短子线", ("短子线",)),
        ("珠珠", ("珠珠",)),
        ("超强细", ("超强细",)),
        ("JP细地", ("JP细地",)),
        ("细地", ("细地",)),
        ("强硬锋", ("强硬锋",)),
        ("弹簧", ("弹簧",)),
        ("有刺", ("有刺",)),
        ("无刺", ("无刺",)),
    ]
    for label, patterns in priority_rules:
        if label == "细地" and "JP细地" in name:
            continue
        if has_any(name, patterns):
            modifiers.append(label)
    return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))


def build_long_leader_family(name: str) -> str:
    tokens = ["加长子线"]
    core = detect_hook(name)
    if not core and "巨物" in name:
        core = "巨物"
    append_unique(tokens, core or "通用")

    modifiers: list[str] = []
    priority_rules = [
        ("珠珠", ("珠珠",)),
        ("缓沉", ("缓沉",)),
        ("护线绳", ("护线绳",)),
        ("无结", ("无结",)),
        ("有刺", ("有刺",)),
        ("无刺", ("无刺",)),
    ]
    for label, patterns in priority_rules:
        if has_any(name, patterns):
            modifiers.append(label)
    return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))


def detect_fish_hook_core(name: str) -> str:
    if "飞得罗" in name:
        return "飞得罗"
    if "黄尾" in name:
        return "黄尾"
    if "狼牙" in name:
        return "狼牙"
    if "岩牙" in name:
        return "岩牙"
    return detect_hook(name) or "通用"


def build_hook_family(name: str) -> str:
    tokens = ["鱼钩"]
    core = detect_fish_hook_core(name)
    append_unique(tokens, core)

    modifiers: list[str] = []
    if core == "狼牙":
        for tag in ("正钓", "竞技", "飞磕", "袖"):
            if tag in name:
                modifiers.append(tag)
                break
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    if core == "岩牙":
        for tag in ("正钓", "竞技", "飞磕"):
            if tag in name:
                modifiers.append(tag)
                break
        return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))

    priority_rules = [
        ("T型扣自分叉", ("T型扣", "自分叉")),
        ("曲柄", ("曲柄",)),
        ("JP细地", ("JP细地",)),
        ("细地", ("细地",)),
        ("强硬锋", ("强硬锋",)),
        ("弹簧", ("弹簧",)),
        ("跑铅", ("跑铅",)),
        ("加长子线", ("加长子线",)),
        ("短子线", ("短子线",)),
        ("鲢鳙", ("鲢鳙",)),
        ("飞磕", ("飞磕",)),
        ("正钓", ("正钓",)),
        ("竞技", ("竞技",)),
    ]

    for label, patterns in priority_rules:
        if label == "T型扣自分叉":
            if all(pattern in name for pattern in patterns):
                modifiers.append(label)
            continue
        if label == "细地" and "JP细地" in name:
            continue
        if has_any(name, patterns):
            modifiers.append(label)

    return "|".join(cleanup_tokens(extend_priority(tokens, modifiers)))


def rebuild_family(product_category: str | None, sku_name: str | None) -> str:
    category = (product_category or "").strip()
    name = normalize_name(sku_name)

    if category == "线组":
        return build_line_group_family(name)
    if category == "无结子线":
        return build_no_knot_family(name)
    if category == "加长子线":
        return build_long_leader_family(name)
    if category == "鱼钩":
        return build_hook_family(name)
    return "未归类"


def load_dim_sku_rows(conn: sqlite3.Connection) -> list[dict[str, str]]:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT sku_code, sku_name, product_category, family_tags
        FROM dim_sku
        ORDER BY product_category, sku_code
        """
    ).fetchall()
    return [dict(row) for row in rows]


def write_change_csv(rows: list[dict[str, str]], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["sku_code", "product_category", "sku_name", "old_family_tags", "new_family_tags", "changed"],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "sku_code": row["sku_code"],
                    "product_category": row["product_category"],
                    "sku_name": row["sku_name"],
                    "old_family_tags": row["old_family_tags"],
                    "new_family_tags": row["new_family_tags"],
                    "changed": int(row["old_family_tags"] != row["new_family_tags"]),
                }
            )


def write_summary_csv(rows: list[dict[str, str]], output_path: Path) -> None:
    counts = Counter(row["new_family_tags"] for row in rows)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(["family_tags", "sku_count"])
        for family, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
            writer.writerow([family, count])


def write_families_markdown(rows: list[dict[str, str]], output_path: Path) -> None:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[row["new_family_tags"]].append(row)

    family_counts = {family: len(items) for family, items in grouped.items()}
    largest_family, largest_count = max(family_counts.items(), key=lambda item: item[1])

    lines: list[str] = [
        "# SKU 业务家族 (Family) 映射表",
        "",
        "> 此文件由 `forecasting/rebuild_family_tags.py` 自动生成，展示当前 `dim_sku` 的业务家族重构结果。",
        "",
        "## 概览",
        f"- SKU 总数: {len(rows)}",
        f"- Family 总数: {len(grouped)}",
        f"- 最大 Family: `{largest_family}` ({largest_count} 个 SKU)",
        f"- 生成日期: {date.today().isoformat()}",
        "",
    ]

    for family in sorted(grouped):
        items = sorted(grouped[family], key=lambda row: (row["sku_name"], row["sku_code"]))
        lines.extend(
            [
                f"## {family}",
                f"**SKU 数量**: {len(items)}",
                "",
                "| 商品编码 (SKU Code) | 商品名称 (SKU Name) |",
                "| :--- | :--- |",
            ]
        )
        for row in items:
            sku_code = row["sku_code"] or ""
            sku_name = (row["sku_name"] or "").replace("|", "\\|")
            lines.append(f"| {sku_code} | {sku_name} |")
        lines.append("")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def apply_updates(conn: sqlite3.Connection, rows: list[dict[str, str]]) -> None:
    updates = [(row["new_family_tags"], row["sku_code"]) for row in rows]
    with conn:
        conn.executemany("UPDATE dim_sku SET family_tags = ? WHERE sku_code = ?", updates)


def print_summary(rows: list[dict[str, str]]) -> None:
    changed = sum(1 for row in rows if row["old_family_tags"] != row["new_family_tags"])
    counts = Counter(row["new_family_tags"] for row in rows)
    print(f"SKU total: {len(rows)}")
    print(f"Family total: {len(counts)}")
    print(f"Changed SKUs: {changed}")
    print("Top 20 families after rebuild:")
    for family, count in counts.most_common(20):
        print(f"  {family}: {count}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild dim_sku.family_tags with local rule-based logic.")
    parser.add_argument("--apply", action="store_true", help="Write new family_tags back to dim_sku.")
    parser.add_argument("--skip-docs", action="store_true", help="Skip regenerating docs/families.md.")
    parser.add_argument("--skip-audit", action="store_true", help="Skip generating change/summary CSV files.")
    args = parser.parse_args()

    conn = sqlite3.connect(DB_PATH)
    rows = load_dim_sku_rows(conn)
    rebuilt_rows: list[dict[str, str]] = []
    for row in rows:
        rebuilt_rows.append(
            {
                "sku_code": str(row["sku_code"] or ""),
                "sku_name": row["sku_name"] or "",
                "product_category": row["product_category"] or "",
                "old_family_tags": row["family_tags"] or "",
                "new_family_tags": rebuild_family(row["product_category"], row["sku_name"]),
            }
        )

    if args.apply:
        apply_updates(conn, rebuilt_rows)

    if not args.skip_audit:
        write_change_csv(rebuilt_rows, CHANGES_CSV_PATH)
        write_summary_csv(rebuilt_rows, SUMMARY_CSV_PATH)

    if not args.skip_docs:
        write_families_markdown(rebuilt_rows, FAMILIES_DOC_PATH)

    print_summary(rebuilt_rows)


if __name__ == "__main__":
    main()
