#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import warnings
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

DB_PATH = BASE_DIR / "data-base" / "sales_filtered.sqlite"
CITIES_DOC_PATH = BASE_DIR / "docs" / "cities.md"
TAGS_DOC_PATH = BASE_DIR / "docs" / "tags.md"
VARIATIONS_DOC_PATH = BASE_DIR / "docs" / "variations.md"
FAMILIES_DOC_PATH = BASE_DIR / "docs" / "families.md"

REQUIRED_COLUMNS = [
    "shop",
    "province",
    "city",
    "sale_date",
    "barcode",
    "product_name",
    "product_category",
    "base_price",
    "list_price",
    "platform",
    "sales_volume",
    "paid_amount",
]

COLUMN_ALIASES = {
    "shop": "shop",
    "店铺": "shop",
    "店铺名称": "shop",
    "province": "province",
    "省份": "province",
    "city": "city",
    "城市": "city",
    "sale_date": "sale_date",
    "日期": "sale_date",
    "下单日期": "sale_date",
    "销售日期": "sale_date",
    "barcode": "barcode",
    "商品编码": "barcode",
    "货号": "barcode",
    "款式编码": "barcode",
    "商品条码": "barcode",
    "product_name": "product_name",
    "商品名称": "product_name",
    "商品简称": "product_name",
    "颜色规格": "product_name",
    "product_category": "product_category",
    "产品分类": "product_category",
    "商品分类": "product_category",
    "base_price": "base_price",
    "基本售价": "base_price",
    "成本单价": "base_price",
    "list_price": "list_price",
    "市场吊牌价": "list_price",
    "吊牌价": "list_price",
    "platform": "platform",
    "所属站点": "platform",
    "平台": "platform",
    "sales_volume": "sales_volume",
    "销售数量": "sales_volume",
    "净销量": "sales_volume",
    "paid_amount": "paid_amount",
    "已付金额": "paid_amount",
    "销售金额": "paid_amount",
    "净销售额": "paid_amount",
}

NULL_CITY_VALUES = {
    "",
    "县",
    "市辖区",
    "省级辖区",
    "省直辖县",
    "省直辖县级行政区划",
    "自治区直辖县级行政区划",
}

SHORT_TO_LONG_CITY_VALUES = {
    "阿坝州": "阿坝藏族羌族自治州",
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
    "玉树州": "玉树藏族自治州",
    "白沙县": "白沙黎族自治县",
    "红河州": "红河哈尼族彝族自治州",
    "黔东南州": "黔东南苗族侗族自治州",
    "黔南州": "黔南布依族苗族自治州",
    "黔西南州": "黔西南布依族苗族自治州",
}

ETHNIC_MARKERS = [
    "土家族",
    "苗族",
    "黎族",
    "回族",
    "彝族",
    "傣族",
    "景颇族",
    "哈尼族",
    "侗族",
    "布依族",
    "壮族",
    "藏族",
    "蒙古族",
    "朝鲜族",
    "傈僳族",
]

ADMIN_SUFFIXES = [
    "自治州",
    "自治县",
    "地区",
    "盟",
    "州",
    "市",
    "县",
]

EXCEL_DATE_STYLE_IDS = {
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    27,
    30,
    36,
    45,
    46,
    47,
    50,
    57,
}

AUTO_TAGS_HEADING = "七、 导入新增标签候选"
SQLITE_BUSY_TIMEOUT_MS = 30000
SQLITE_LOCK_RETRIES = 6
SQLITE_LOCK_RETRY_SECONDS = 2.0

ROW_KEY_SQL = """
json_array(
  COALESCE(shop, ''),
  COALESCE(province, ''),
  COALESCE(city, ''),
  COALESCE(sale_date, ''),
  COALESCE(barcode, ''),
  COALESCE(product_name, ''),
  COALESCE(product_category, ''),
  COALESCE(base_price, 0),
  COALESCE(list_price, 0),
  COALESCE(platform, ''),
  COALESCE(sales_volume, 0),
  COALESCE(paid_amount, 0)
)
""".strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import sales Excel into SQLite for Feishu workflow")
    parser.add_argument("--excel-path", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--db-path", default=str(DB_PATH))
    parser.add_argument("--cities-doc-path", default=str(CITIES_DOC_PATH))
    parser.add_argument("--tags-doc-path", default=str(TAGS_DOC_PATH))
    parser.add_argument("--variations-doc-path", default=str(VARIATIONS_DOC_PATH))
    parser.add_argument("--families-doc-path", default=str(FAMILIES_DOC_PATH))
    return parser.parse_args()


def load_cities_doc(path: Path) -> list[str]:
    if not path.exists():
        return []
    cities: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("- "):
            city = line[2:].strip()
            if city:
                cities.append(SHORT_TO_LONG_CITY_VALUES.get(city, city))
    return cities


def write_cities_doc(path: Path, cities: list[str]) -> None:
    normalized_cities = [SHORT_TO_LONG_CITY_VALUES.get(city, city) for city in cities]
    sorted_cities = sorted(set(normalized_cities))
    body_lines = [
        "# 数据库城市去重列表 (Unique Cities in Database)",
        f"**统计日期：** {datetime.now().strftime('%Y-%m-%d')}",
        f"**总计：** {len(sorted_cities)} 个唯一城市/行政区项",
        "*(注：当前列表基于清洗后的数据库去重结果；简称、旧称和泛化值已统一到官方全称或处理为空值，不再重复出现在列表中)*",
        "",
    ]
    body_lines.extend(f"- {city}" for city in sorted_cities)
    path.write_text("\n".join(body_lines) + "\n", encoding="utf-8")


def canonicalize_city_name(value: str) -> str:
    normalized = value.strip().replace(" ", "")
    for marker in ETHNIC_MARKERS:
        normalized = normalized.replace(marker, "")
    for suffix in ADMIN_SUFFIXES:
        normalized = normalized.removesuffix(suffix)
    return normalized


def normalize_city(value: object, known_cities: set[str]) -> tuple[str, str | None, tuple[str, str] | None]:
    raw = "" if pd.isna(value) else str(value).strip().replace(" ", "")
    if not raw or raw in NULL_CITY_VALUES:
        cleaned = ""
        if raw and raw != cleaned:
            return cleaned, None, (raw, cleaned)
        return cleaned, None, None

    if raw in SHORT_TO_LONG_CITY_VALUES:
        normalized = SHORT_TO_LONG_CITY_VALUES[raw]
        return normalized, None, (raw, normalized)

    if raw in known_cities:
        return raw, None, None

    raw_canonical = canonicalize_city_name(raw)
    if raw_canonical:
        matches = [city for city in known_cities if canonicalize_city_name(city) == raw_canonical]
        if len(matches) == 1:
            return matches[0], None, (raw, matches[0])

    return raw, raw, None


def read_excel(excel_path: Path) -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Workbook contains no default style.*", category=UserWarning)
        try:
            return pd.read_excel(excel_path)
        except ValueError as exc:
            if "valid column name" not in str(exc):
                raise
    return read_excel_with_xlsx_xml_fallback(excel_path)


def read_excel_with_xlsx_xml_fallback(excel_path: Path) -> pd.DataFrame:
    if not zipfile.is_zipfile(excel_path):
        raise ValueError("Broken-workbook fallback requires an Excel zip container")

    with zipfile.ZipFile(excel_path) as archive:
        if "xl/workbook.xml" not in archive.namelist():
            raise ValueError("Broken-workbook fallback requires an .xlsx-compatible workbook payload")
        shared_strings = load_shared_strings(archive)
        date_style_ids = load_date_style_ids(archive)
        uses_1904_date_system = workbook_uses_1904_date_system(archive)
        sheet_path = resolve_first_sheet_path(archive)
        rows = parse_sheet_rows(archive, sheet_path, shared_strings, date_style_ids, uses_1904_date_system)

    if not rows:
        return pd.DataFrame()

    header_row = next((row for row in rows if any(str(value).strip() for value in row)), rows[0])
    header_index = rows.index(header_row)
    headers = [str(value).strip() if value is not None else "" for value in header_row]
    normalized_headers = []
    for index, header in enumerate(headers, start=1):
        normalized_headers.append(header or f"unnamed_{index}")
    data_rows = rows[header_index + 1 :]
    return pd.DataFrame(data_rows, columns=normalized_headers)


def resolve_first_sheet_path(archive: zipfile.ZipFile) -> str:
    workbook_root = ET.fromstring(archive.read("xl/workbook.xml"))
    namespace = {"ns": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rel_namespace = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    first_sheet = workbook_root.find("ns:sheets/ns:sheet", namespace)
    if first_sheet is None:
        raise ValueError("Workbook does not contain any sheets")
    rel_id = first_sheet.attrib.get(f"{rel_namespace}id")
    if not rel_id:
        raise ValueError("Workbook first sheet is missing relationship id")

    rels_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    rels_namespace = {"ns": "http://schemas.openxmlformats.org/package/2006/relationships"}
    for rel in rels_root.findall("ns:Relationship", rels_namespace):
        if rel.attrib.get("Id") == rel_id:
            target = rel.attrib.get("Target", "")
            normalized_target = target.lstrip("/")
            return normalized_target if normalized_target.startswith("xl/") else f"xl/{normalized_target}"
    raise ValueError(f"Workbook relationship {rel_id} not found")


def load_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        xml_bytes = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(xml_bytes)
    namespace = {"ns": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    strings: list[str] = []
    for item in root.findall("ns:si", namespace):
        text_parts = [node.text or "" for node in item.findall(".//ns:t", namespace)]
        strings.append("".join(text_parts))
    return strings


def workbook_uses_1904_date_system(archive: zipfile.ZipFile) -> bool:
    workbook_root = ET.fromstring(archive.read("xl/workbook.xml"))
    namespace = {"ns": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    workbook_props = workbook_root.find("ns:workbookPr", namespace)
    if workbook_props is None:
        return False
    return workbook_props.attrib.get("date1904") == "1"


def load_date_style_ids(archive: zipfile.ZipFile) -> set[int]:
    try:
        styles_root = ET.fromstring(archive.read("xl/styles.xml"))
    except KeyError:
        return set(EXCEL_DATE_STYLE_IDS)

    namespace = {"ns": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    custom_date_formats: set[int] = set()
    num_fmts = styles_root.find("ns:numFmts", namespace)
    if num_fmts is not None:
        for num_fmt in num_fmts.findall("ns:numFmt", namespace):
            num_fmt_id = parse_style_id(num_fmt.attrib.get("numFmtId"))
            format_code = num_fmt.attrib.get("formatCode", "")
            if num_fmt_id is not None and is_excel_date_format(format_code):
                custom_date_formats.add(num_fmt_id)

    date_style_ids: set[int] = set()
    cell_xfs = styles_root.find("ns:cellXfs", namespace)
    if cell_xfs is None:
        return set(EXCEL_DATE_STYLE_IDS)
    for index, cell_xf in enumerate(cell_xfs.findall("ns:xf", namespace)):
        num_fmt_id = parse_style_id(cell_xf.attrib.get("numFmtId"))
        if num_fmt_id is None:
            continue
        if num_fmt_id in EXCEL_DATE_STYLE_IDS or num_fmt_id in custom_date_formats:
            date_style_ids.add(index)
    return date_style_ids


def parse_style_id(raw_value: str | None) -> int | None:
    if raw_value is None or raw_value == "":
        return None
    try:
        return int(raw_value)
    except ValueError:
        return None


def is_excel_date_format(format_code: str) -> bool:
    if not format_code:
        return False
    normalized = re.sub(r'".*?"|\[[^\]]+\]|\\.|_.', "", format_code).lower()
    if "general" in normalized:
        return False
    return any(token in normalized for token in ("yy", "dd", "mm", "hh", "ss"))


def parse_sheet_rows(
    archive: zipfile.ZipFile,
    sheet_path: str,
    shared_strings: list[str],
    date_style_ids: set[int],
    uses_1904_date_system: bool,
) -> list[list[object]]:
    root = ET.fromstring(archive.read(sheet_path))
    namespace = {"ns": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rows: list[list[object]] = []
    for row in root.findall(".//ns:sheetData/ns:row", namespace):
        parsed = parse_sheet_row(row, namespace, shared_strings, date_style_ids, uses_1904_date_system)
        if parsed:
            rows.append(parsed)
    return rows


def parse_sheet_row(
    row: ET.Element,
    namespace: dict[str, str],
    shared_strings: list[str],
    date_style_ids: set[int],
    uses_1904_date_system: bool,
) -> list[object]:
    values_by_column: dict[int, object] = {}
    next_column_index = 1
    max_column_index = 0

    for cell in row.findall("ns:c", namespace):
        cell_ref = cell.attrib.get("r", "")
        column_index = extract_column_index(cell_ref) or next_column_index
        next_column_index = max(next_column_index, column_index + 1)
        max_column_index = max(max_column_index, column_index)
        values_by_column[column_index] = parse_cell_value(
            cell,
            namespace,
            shared_strings,
            date_style_ids,
            uses_1904_date_system,
        )

    if max_column_index == 0:
        return []
    return [values_by_column.get(index, "") for index in range(1, max_column_index + 1)]


def extract_column_index(cell_ref: str) -> int | None:
    match = re.match(r"^([A-Z]+)\d+$", cell_ref.strip(), flags=re.IGNORECASE)
    if not match:
        return None
    letters = match.group(1).upper()
    index = 0
    for letter in letters:
        index = index * 26 + (ord(letter) - ord("A") + 1)
    return index


def parse_cell_value(
    cell: ET.Element,
    namespace: dict[str, str],
    shared_strings: list[str],
    date_style_ids: set[int],
    uses_1904_date_system: bool,
) -> object:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//ns:t", namespace))

    value_node = cell.find("ns:v", namespace)
    raw_value = value_node.text if value_node is not None else ""
    if raw_value is None:
        raw_value = ""

    if cell_type == "s":
        try:
            return shared_strings[int(raw_value)]
        except (IndexError, ValueError):
            return raw_value
    if cell_type == "b":
        return raw_value == "1"
    if cell_type in {"str", "e"}:
        return raw_value

    if raw_value == "":
        return ""
    style_id = parse_style_id(cell.attrib.get("s"))
    try:
        numeric = float(raw_value)
        if style_id in date_style_ids:
            return convert_excel_serial_date(numeric, uses_1904_date_system)
        return int(numeric) if numeric.is_integer() else numeric
    except ValueError:
        return raw_value


def convert_excel_serial_date(serial: float, uses_1904_date_system: bool) -> str:
    if uses_1904_date_system:
        base_date = datetime(1904, 1, 1)
    else:
        # Excel's default 1900 date system includes the historic leap-year bug.
        base_date = datetime(1899, 12, 30)
    converted = base_date + timedelta(days=serial)
    if converted.time() == datetime.min.time():
        return converted.strftime("%Y-%m-%d")
    return converted.strftime("%Y-%m-%d %H:%M:%S")


def classify_excel_read_error(error: Exception) -> str:
    message = str(error)
    lowered = message.lower()
    if "valid column name" in lowered:
        return "Excel 文件结构异常，已尝试兼容读取但仍失败。请重新导出为标准 .xlsx 后再试。"
    if "broken-workbook fallback requires an .xlsx-compatible workbook payload" in lowered:
        return "收到的附件不是有效的 Excel 工作簿内容，暂时无法导入。请重新发送原始 Excel 文件。"
    if "broken-workbook fallback requires an excel zip container" in lowered:
        return "收到的附件不是可识别的 Excel 文件，暂时无法导入。请发送原始 .xlsx 文件。"
    if isinstance(error, zipfile.BadZipFile):
        return "Excel 文件已损坏或内容不完整，暂时无法导入。请重新导出后再试。"
    return "Excel 文件读取失败。请重新导出为标准 .xlsx 后再试。"


def normalize_headers(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    source_columns: dict[str, list[str]] = {}
    passthrough_columns: list[str] = []

    for col in df.columns:
        original = str(col).strip()
        normalized = original.lower()
        canonical = COLUMN_ALIASES.get(original) or COLUMN_ALIASES.get(normalized) or normalized
        if canonical in REQUIRED_COLUMNS:
            source_columns.setdefault(canonical, []).append(col)
        else:
            passthrough_columns.append(col)

    normalized_data: dict[str, pd.Series] = {}
    for canonical, columns in source_columns.items():
        merged = df[columns[0]]
        for column in columns[1:]:
            merged = merged.where(~merged.isna() & (merged.astype(str).str.strip() != ""), df[column])
        normalized_data[canonical] = merged

    normalized_df = pd.DataFrame(normalized_data)
    for col in passthrough_columns:
        normalized = str(col).strip().lower()
        if normalized not in normalized_df.columns:
            normalized_df[normalized] = df[col]

    missing = [col for col in REQUIRED_COLUMNS if col not in normalized_df.columns]
    return normalized_df, missing


def normalize_dataframe(
    df: pd.DataFrame, known_cities: set[str]
) -> tuple[pd.DataFrame, list[str], list[tuple[str, str]]]:
    normalized = df[REQUIRED_COLUMNS].copy()
    for column in ["shop", "province", "city", "sale_date", "barcode", "product_name", "product_category", "platform"]:
        normalized[column] = normalized[column].map(lambda value: "" if pd.isna(value) else str(value).strip())

    added_cities: list[str] = []
    normalized_city_pairs: list[tuple[str, str]] = []
    city_values: list[str] = []
    for city in normalized["city"].tolist():
        cleaned, new_city, normalized_pair = normalize_city(city, known_cities)
        city_values.append(cleaned)
        if new_city:
            added_cities.append(new_city)
            known_cities.add(new_city)
        if normalized_pair:
            normalized_city_pairs.append(normalized_pair)
    normalized["city"] = city_values

    normalized["sale_date"] = pd.to_datetime(normalized["sale_date"], errors="coerce").dt.strftime("%Y-%m-%d")
    normalized["sale_date"] = normalized["sale_date"].fillna("")
    normalized = normalized[(normalized["sale_date"] != "") & (normalized["barcode"] != "")]

    for column in ["base_price", "list_price", "paid_amount"]:
        normalized[column] = pd.to_numeric(normalized[column], errors="coerce")
    normalized["sales_volume"] = pd.to_numeric(normalized["sales_volume"], errors="coerce").fillna(0).astype(int)

    normalized = normalized.drop_duplicates(subset=REQUIRED_COLUMNS, keep="first")
    return normalized, sorted(set(added_cities)), sorted(set(normalized_city_pairs))


def parse_doc_bullets(path: Path) -> set[str]:
    values: set[str] = set()
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        raw = stripped[2:]
        if "：" in raw:
            raw = raw.split("：", 1)[1]
        elif ":" in raw:
            raw = raw.split(":", 1)[1]
        for part in re.split(r"[,，、\s。]+", raw):
            token = part.strip()
            if len(token) > 1:
                values.add(token)
    return values


def load_keywords(tags_file_path: Path) -> set[str]:
    from forecasting.utils.tag_extractor import load_keywords as _load_keywords

    return set(_load_keywords(str(tags_file_path)))


def extract_tags_from_name(name: str, keyword_list: set[str]) -> list[str]:
    from forecasting.utils.tag_extractor import extract_tags_from_name as _extract_tags_from_name

    return list(_extract_tags_from_name(name, keyword_list))


def rebuild_family(product_category: str, sku_name: str) -> str:
    from forecasting.rebuild_family_tags import rebuild_family as _rebuild_family

    return str(_rebuild_family(product_category, sku_name))


def write_families_markdown_from_db(conn: sqlite3.Connection, output_path: Path) -> None:
    from forecasting.rebuild_family_tags import load_dim_sku_rows, write_families_markdown

    rows = load_dim_sku_rows(conn)
    rebuilt_rows = [
        {
            "sku_code": str(row["sku_code"] or ""),
            "sku_name": row["sku_name"] or "",
            "product_category": row["product_category"] or "",
            "old_family_tags": row["family_tags"] or "",
            "new_family_tags": row["family_tags"] or "",
        }
        for row in rows
    ]
    write_families_markdown(rebuilt_rows, output_path)


def extract_spec_length(name: str) -> str:
    match = re.search(r"(\d+(?:\.\d+)?\s*(?:米|m|cm))", name, re.IGNORECASE)
    if not match:
        return ""
    value = match.group(1).replace(" ", "")
    if value.lower().endswith("m") and not value.endswith("cm"):
        value = f"{value[:-1]}米"
    return value


def extract_spec_hook(name: str) -> str:
    match = re.search(r"(钩\d+(?:\.\d+)?号)", name)
    return match.group(1) if match else ""


def extract_spec_qty(name: str) -> str:
    match = re.search(r"(\d+\s*付)", name)
    if not match:
        return ""
    return match.group(1).replace(" ", "")


def extract_spec_size(name: str, hook_value: str) -> str:
    if hook_value:
        return ""
    candidates = re.findall(r"(\d+(?:\.\d+)?号)", name)
    if not candidates:
        return ""
    return candidates[0]


def derive_product_root(product_category: str, family_segments: list[str], business_tags: list[str]) -> str:
    values = [product_category]
    for tag in family_segments:
        if tag and tag not in values and tag != product_category:
            values.append(tag)
    for tag in business_tags:
        if tag and tag not in values and tag != product_category:
            values.append(tag)
    return "|".join(values)


def build_variant_key(product_root: str, spec_length: str, spec_size: str, spec_hook: str, spec_qty: str) -> str:
    return "|".join([product_root, spec_length, spec_size, spec_hook, spec_qty])


def build_sku_dimension_rows(
    conn: sqlite3.Connection, imported_df: pd.DataFrame, tags_doc_path: Path
) -> tuple[list[tuple], list[tuple[str, str]], list[str], list[dict[str, object]]]:
    keyword_list = load_keywords(tags_doc_path)
    existing_tags = parse_doc_bullets(tags_doc_path)
    dim_rows: list[tuple] = []
    sku_tag_rows: list[tuple[str, str]] = []
    new_tag_candidates: set[str] = set()
    sku_label_summaries: list[dict[str, object]] = []

    grouped = (
        imported_df.sort_values(["sale_date", "barcode"])
        .groupby("barcode", as_index=False)
        .agg(
            sku_name=("product_name", "last"),
            product_category=("product_category", "last"),
            last_tag_price=("list_price", "last"),
            last_base_price=("base_price", "last"),
            first_seen_date=("sale_date", "min"),
            last_seen_date=("sale_date", "max"),
        )
    )

    for row in grouped.itertuples(index=False):
        sku_code = str(row.barcode).strip()
        sku_name = str(row.sku_name or "").strip()
        product_category = str(row.product_category or "").strip()
        business_tags = extract_tags_from_name(sku_name, keyword_list)
        family_tags = rebuild_family(product_category, sku_name)
        family_segments = [segment for segment in family_tags.split("|") if segment and segment != product_category]
        for segment in family_segments:
            if (
                len(segment) > 1
                and segment not in existing_tags
                and segment not in {"通用", "普通", "未归类"}
                and not re.search(r"\d", segment)
            ):
                new_tag_candidates.add(segment)

        spec_length = extract_spec_length(sku_name)
        spec_hook = extract_spec_hook(sku_name)
        spec_qty = extract_spec_qty(sku_name)
        spec_size = extract_spec_size(sku_name, spec_hook)
        product_root = derive_product_root(product_category, family_segments, business_tags)
        variant_key = build_variant_key(product_root, spec_length, spec_size, spec_hook, spec_qty)

        dim_rows.append(
            (
                sku_code,
                sku_name,
                product_category,
                row.last_tag_price,
                row.last_base_price,
                row.first_seen_date,
                row.last_seen_date,
                spec_length or None,
                spec_size or None,
                spec_hook or None,
                spec_qty or None,
                family_tags or None,
                variant_key or None,
            )
        )

        merged_tags = []
        for tag in [*business_tags, *family_segments]:
            if tag and tag not in merged_tags and tag != product_category:
                merged_tags.append(tag)
        for tag in [spec_length, spec_size, spec_hook, spec_qty]:
            if tag and tag not in merged_tags:
                merged_tags.append(tag)
        for tag_name in merged_tags:
            sku_tag_rows.append((sku_code, tag_name))

        sku_label_summaries.append(
            {
                "sku_code": sku_code,
                "sku_name": sku_name,
                "product_category": product_category,
                "business_tags": business_tags,
                "family_tags": family_tags,
                "product_root": product_root,
                "spec_length": spec_length,
                "spec_size": spec_size,
                "spec_hook": spec_hook,
                "spec_qty": spec_qty,
                "applied_tags": merged_tags,
            }
        )

    return dim_rows, sku_tag_rows, sorted(new_tag_candidates), sku_label_summaries


def upsert_dim_sku_and_tags(
    conn: sqlite3.Connection, imported_df: pd.DataFrame, tags_doc_path: Path
) -> tuple[list[str], list[dict[str, object]]]:
    dim_rows, sku_tag_rows, new_tag_candidates, sku_label_summaries = build_sku_dimension_rows(
        conn,
        imported_df,
        tags_doc_path,
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dim_sku (
          sku_code TEXT PRIMARY KEY,
          sku_name TEXT,
          product_category TEXT,
          last_tag_price REAL,
          last_base_price REAL,
          first_seen_date TEXT,
          last_seen_date TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          spec_length TEXT,
          spec_size TEXT,
          spec_hook TEXT,
          spec_qty TEXT,
          family_tags TEXT,
          variant_key TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sku_tags (
          sku_code TEXT,
          tag_name TEXT,
          PRIMARY KEY (sku_code, tag_name),
          FOREIGN KEY (sku_code) REFERENCES dim_sku(sku_code)
        )
        """
    )

    conn.executemany(
        """
        INSERT INTO dim_sku (
          sku_code, sku_name, product_category, last_tag_price, last_base_price,
          first_seen_date, last_seen_date, spec_length, spec_size, spec_hook,
          spec_qty, family_tags, variant_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sku_code) DO UPDATE SET
          sku_name = excluded.sku_name,
          product_category = excluded.product_category,
          last_tag_price = excluded.last_tag_price,
          last_base_price = excluded.last_base_price,
          first_seen_date = CASE
            WHEN dim_sku.first_seen_date IS NULL OR dim_sku.first_seen_date = '' THEN excluded.first_seen_date
            WHEN excluded.first_seen_date IS NULL OR excluded.first_seen_date = '' THEN dim_sku.first_seen_date
            ELSE MIN(dim_sku.first_seen_date, excluded.first_seen_date)
          END,
          last_seen_date = CASE
            WHEN dim_sku.last_seen_date IS NULL OR dim_sku.last_seen_date = '' THEN excluded.last_seen_date
            WHEN excluded.last_seen_date IS NULL OR excluded.last_seen_date = '' THEN dim_sku.last_seen_date
            ELSE MAX(dim_sku.last_seen_date, excluded.last_seen_date)
          END,
          spec_length = excluded.spec_length,
          spec_size = excluded.spec_size,
          spec_hook = excluded.spec_hook,
          spec_qty = excluded.spec_qty,
          family_tags = excluded.family_tags,
          variant_key = excluded.variant_key,
          updated_at = CURRENT_TIMESTAMP
        """,
        dim_rows,
    )
    conn.executemany(
        "INSERT OR IGNORE INTO sku_tags (sku_code, tag_name) VALUES (?, ?)",
        sku_tag_rows,
    )
    return new_tag_candidates, sku_label_summaries


def refresh_variations_doc(conn: sqlite3.Connection, output_path: Path) -> None:
    def fetch_counts(column: str) -> list[tuple[str, int]]:
        return list(
            conn.execute(
                f"""
                SELECT {column}, COUNT(*) AS c
                FROM dim_sku
                WHERE {column} IS NOT NULL AND TRIM({column}) <> ''
                GROUP BY {column}
                ORDER BY c DESC, {column}
                """
            ).fetchall()
        )

    length_counts = fetch_counts("spec_length")
    size_counts = fetch_counts("spec_size")
    hook_counts = fetch_counts("spec_hook")
    qty_counts = fetch_counts("spec_qty")

    def bullets(rows: list[tuple[str, int]], limit: int = 15) -> list[str]:
        return [f"- {value} ({count})" for value, count in rows[:limit]]

    lines = [
        "# 商品规格变体 (Product Variations)",
        "本文件记录了 `dim_sku` 表中提取的常见规格变体及其出现频率。",
        "",
        "## 1. 长度规格 (Length)",
        "",
        "### 长度 / 线长",
        *bullets(length_counts),
        "",
        "## 2. 号数规格 (Size / Line No)",
        "",
        "### 通用号数",
        *bullets(size_counts),
        "",
        "### 钩号",
        *bullets(hook_counts),
        "",
        "## 3. 数量规格 (Quantity)",
        *bullets(qty_counts),
        "",
        "---",
        f"*数据提取自 `dim_sku` 表，统计日期：{datetime.now().strftime('%Y-%m-%d')}*",
        "",
    ]
    output_path.write_text("\n".join(lines), encoding="utf-8")


def refresh_tags_doc(path: Path, new_tags: list[str]) -> list[str]:
    if not new_tags:
        return []
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    existing = parse_doc_bullets(path)
    fresh_tags = [tag for tag in new_tags if tag not in existing]
    if not fresh_tags:
        return []

    lines = text.splitlines() if text else []
    heading_index = next((idx for idx, line in enumerate(lines) if line.strip() == AUTO_TAGS_HEADING), -1)
    if heading_index >= 0:
        lines = lines[:heading_index]
        while lines and lines[-1].strip() == "":
            lines.pop()
    if lines and lines[-1].strip() != "":
        lines.append("")
    lines.append(AUTO_TAGS_HEADING)
    lines.append("")
    for tag in fresh_tags:
        lines.append(f"- {tag}")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    return fresh_tags


def record_import_log(conn: sqlite3.Connection, file_name: str, row_count: int) -> None:
    conn.execute(
        """
        INSERT INTO import_log (file_name, row_count, imported_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(file_name) DO UPDATE SET
          row_count = excluded.row_count,
          imported_at = CURRENT_TIMESTAMP
        """,
        (file_name, row_count),
    )


def ensure_sales_import_indexes(conn: sqlite3.Connection) -> None:
    # Import dedupe narrows existing rows by barcode + sale_date. A composite index
    # keeps this candidate lookup from degenerating into a large scan on the 15M-row table.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sales_barcode_date ON sales(barcode, sale_date)")


def import_rows(
    conn: sqlite3.Connection, rows: pd.DataFrame
) -> tuple[dict[str, object], pd.DataFrame, set[str]]:
    conn.execute("BEGIN IMMEDIATE")
    ensure_sales_import_indexes(conn)
    conn.execute("DROP TABLE IF EXISTS temp_sales_import")
    conn.execute(
        """
        CREATE TEMP TABLE temp_sales_import (
          shop TEXT,
          province TEXT,
          city TEXT,
          sale_date TEXT,
          barcode TEXT,
          product_name TEXT,
          product_category TEXT,
          base_price REAL,
          list_price REAL,
          platform TEXT,
          sales_volume INTEGER,
          paid_amount REAL,
          row_key TEXT
        )
        """
    )

    insert_sql = """
      INSERT INTO temp_sales_import (
        shop, province, city, sale_date, barcode, product_name, product_category,
        base_price, list_price, platform, sales_volume, paid_amount, row_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    row_tuples = []
    for row in rows.itertuples(index=False, name=None):
        row_tuples.append(
            (
                *row,
                json.dumps(
                    [
                        row[0] or "",
                        row[1] or "",
                        row[2] or "",
                        row[3] or "",
                        row[4] or "",
                        row[5] or "",
                        row[6] or "",
                        0 if row[7] is None else row[7],
                        0 if row[8] is None else row[8],
                        row[9] or "",
                        0 if row[10] is None else row[10],
                        0 if row[11] is None else row[11],
                    ],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            )
        )
    conn.executemany(insert_sql, row_tuples)
    conn.execute("CREATE INDEX temp_idx_sales_import_barcode ON temp_sales_import(barcode)")
    conn.execute("CREATE INDEX temp_idx_sales_import_row_key ON temp_sales_import(row_key)")

    existing_barcodes = {
        str(row[0])
        for row in conn.execute("SELECT DISTINCT barcode FROM sales WHERE TRIM(COALESCE(barcode, '')) <> ''")
    }
    incoming_barcodes = {
        str(row[0])
        for row in conn.execute(
            "SELECT DISTINCT barcode FROM temp_sales_import WHERE TRIM(COALESCE(barcode, '')) <> ''"
        )
    }
    new_sku_codes = incoming_barcodes - existing_barcodes
    new_sku_count = len(new_sku_codes)

    row = conn.execute(
        """
        SELECT
          COUNT(*) AS row_count,
          COUNT(DISTINCT barcode) AS sku_count,
          MIN(sale_date) AS min_sale_date,
          MAX(sale_date) AS max_sale_date
        FROM temp_sales_import
        """
    ).fetchone()
    min_sale_date = row[2] or ""
    max_sale_date = row[3] or ""

    conn.execute("DROP TABLE IF EXISTS temp_sales_existing")
    conn.execute(
        f"""
        CREATE TEMP TABLE temp_sales_existing AS
        SELECT
          shop,
          province,
          city,
          sale_date,
          barcode,
          product_name,
          product_category,
          base_price,
          list_price,
          platform,
          sales_volume,
          paid_amount,
          {ROW_KEY_SQL} AS row_key
        FROM sales
        WHERE sale_date BETWEEN ? AND ?
          AND barcode IN (
            SELECT DISTINCT barcode
            FROM temp_sales_import
            WHERE TRIM(COALESCE(barcode, '')) <> ''
          )
        """,
        (min_sale_date, max_sale_date),
    )
    conn.execute("CREATE INDEX temp_idx_sales_existing_row_key ON temp_sales_existing(row_key)")

    conn.execute("DROP TABLE IF EXISTS temp_sales_to_insert")
    conn.execute(
        """
        CREATE TEMP TABLE temp_sales_to_insert AS
        SELECT
          s.shop,
          s.province,
          s.city,
          s.sale_date,
          s.barcode,
          s.product_name,
          s.product_category,
          s.base_price,
          s.list_price,
          s.platform,
          s.sales_volume,
          s.paid_amount
        FROM temp_sales_import s
        LEFT JOIN temp_sales_existing e ON e.row_key = s.row_key
        WHERE e.row_key IS NULL
        """
    )

    inserted_df = pd.read_sql_query("SELECT * FROM temp_sales_to_insert", conn)

    row = conn.execute(
        """
        SELECT
          COUNT(*) AS row_count,
          COUNT(DISTINCT barcode) AS sku_count,
          MIN(sale_date) AS min_sale_date,
          MAX(sale_date) AS max_sale_date
        FROM temp_sales_to_insert
        """
    ).fetchone()

    conn.execute(
        """
        INSERT INTO sales (
          shop, province, city, sale_date, barcode, product_name, product_category,
          base_price, list_price, platform, sales_volume, paid_amount
        )
        SELECT
          shop, province, city, sale_date, barcode, product_name, product_category,
          base_price, list_price, platform, sales_volume, paid_amount
        FROM temp_sales_to_insert
        """
    )
    conn.commit()

    return (
        {
            "inserted_row_count": int(row[0] or 0),
            "inserted_sku_count": int(row[1] or 0),
            "inserted_min_sale_date": row[2] or "",
            "inserted_max_sale_date": row[3] or "",
            "new_sku_count": new_sku_count,
        },
        inserted_df,
        new_sku_codes,
    )


def is_locked_error(error: sqlite3.OperationalError) -> bool:
    return "database is locked" in str(error).lower()


def import_rows_with_retry(
    conn: sqlite3.Connection, rows: pd.DataFrame
) -> tuple[dict[str, object], pd.DataFrame, set[str]]:
    last_error: sqlite3.OperationalError | None = None
    for attempt in range(1, SQLITE_LOCK_RETRIES + 1):
        try:
            return import_rows(conn, rows)
        except sqlite3.OperationalError as error:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            if not is_locked_error(error):
                raise
            last_error = error
            if attempt >= SQLITE_LOCK_RETRIES:
                break
            time.sleep(SQLITE_LOCK_RETRY_SECONDS)
    assert last_error is not None
    raise last_error


def main() -> None:
    args = parse_args()
    excel_path = Path(args.excel_path).expanduser().resolve()
    db_path = Path(args.db_path).expanduser().resolve()
    cities_doc_path = Path(args.cities_doc_path).expanduser().resolve()
    tags_doc_path = Path(args.tags_doc_path).expanduser().resolve()
    variations_doc_path = Path(args.variations_doc_path).expanduser().resolve()
    families_doc_path = Path(args.families_doc_path).expanduser().resolve()
    if not excel_path.exists():
        print(json.dumps({"status": "error", "message": f"Excel file not found: {excel_path}"}, ensure_ascii=False))
        return

    try:
        df = read_excel(excel_path)
    except Exception as error:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": classify_excel_read_error(error),
                },
                ensure_ascii=False,
            )
        )
        return
    normalized_df, missing = normalize_headers(df)
    if missing:
        print(
            json.dumps(
                {
                    "status": "missing_fields",
                    "missing_fields": missing,
                },
                ensure_ascii=False,
            )
        )
        return

    known_cities = set(load_cities_doc(cities_doc_path))
    import_df, added_cities, normalized_city_pairs = normalize_dataframe(normalized_df, known_cities)

    conn = sqlite3.connect(db_path, timeout=SQLITE_BUSY_TIMEOUT_MS / 1000)
    conn.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.DatabaseError:
        pass
    try:
        stats, inserted_df, new_sku_codes = import_rows_with_retry(conn, import_df)
        new_sku_df = (
            inserted_df[inserted_df["barcode"].astype(str).isin(new_sku_codes)].copy()
            if not inserted_df.empty
            else inserted_df
        )
        if not new_sku_df.empty:
            added_tags, new_sku_labels = upsert_dim_sku_and_tags(conn, new_sku_df, tags_doc_path)
        else:
            added_tags, new_sku_labels = [], []
        if not new_sku_df.empty:
            refresh_variations_doc(conn, variations_doc_path)
            write_families_markdown_from_db(conn, families_doc_path)
        recorded_tags = refresh_tags_doc(tags_doc_path, added_tags) if added_tags else []
        record_import_log(conn, excel_path.name, int(stats["inserted_row_count"]))
        conn.commit()
    finally:
        conn.close()

    if added_cities:
        write_cities_doc(cities_doc_path, sorted(known_cities))

    result = {
        "status": "imported",
        "excel_path": str(excel_path),
        "inserted_row_count": stats["inserted_row_count"],
        "inserted_sku_count": stats["inserted_sku_count"],
        "new_sku_count": stats["new_sku_count"],
        "date_range": {
            "start": stats["inserted_min_sale_date"],
            "end": stats["inserted_max_sale_date"],
        },
        "added_cities": added_cities,
        "normalized_cities": [
            {"from": source, "to": target} for source, target in normalized_city_pairs
        ],
        "added_tags": recorded_tags,
        "new_sku_labels": new_sku_labels,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except sqlite3.OperationalError as error:
        if "database is locked" in str(error).lower():
            print(
                json.dumps(
                    {
                        "status": "error",
                        "message": f"数据库当前正忙，重试了 {SQLITE_LOCK_RETRIES} 次仍未拿到写锁，请稍后再试。",
                    },
                    ensure_ascii=False,
                )
            )
            sys.exit(0)
        raise
