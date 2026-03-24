-- 久岩销售预测模型 数据库视图定义 (V5.6)

-- 1. 月度 SKU 汇总视图 (包含渠道、支付金额、活跃店铺数等)
DROP VIEW IF EXISTS v_monthly_sku_sales;
CREATE VIEW v_monthly_sku_sales AS
SELECT 
    substr(sale_date, 1, 7) AS year_month,
    barcode AS sku_code,
    SUM(sales_volume) AS monthly_qty,
    AVG(base_price) AS avg_base_price,
    AVG(list_price) AS avg_tag_price,
    SUM(paid_amount) AS total_paid_amount,
    MAX(platform) AS primary_channel,
    COUNT(DISTINCT shop) AS active_stores_per_sku
FROM sales
GROUP BY substr(sale_date, 1, 7), barcode;

-- 2. SKU 地域画像视图 (标识每个 SKU 的核心销售省份)
DROP VIEW IF EXISTS v_sku_region_profile;
CREATE VIEW v_sku_region_profile AS
WITH ProvinceSales AS (
    SELECT barcode as variant_key, province as top_province, SUM(sales_volume) as total_qty
    FROM sales
    GROUP BY barcode, province
),
RankedProvinces AS (
    SELECT variant_key, top_province, total_qty,
           ROW_NUMBER() OVER (PARTITION BY variant_key ORDER BY total_qty DESC) as rn
    FROM ProvinceSales
)
SELECT variant_key, top_province
FROM RankedProvinces
WHERE rn = 1;

-- 3. 训练/预测基础宽表 (集成 SKU 维表、月度销量、地域画像)
DROP VIEW IF EXISTS v_training_base;
CREATE VIEW v_training_base AS
SELECT 
    s.sku_code AS variant_key,
    s.year_month,
    s.monthly_qty,
    s.total_paid_amount,
    s.avg_base_price,
    s.avg_tag_price,
    s.primary_channel AS main_channel,
    s.active_stores_per_sku AS max_active_stores,
    d.product_category,
    d.family_tags,
    d.spec_length,
    d.spec_size,
    d.spec_hook,
    d.spec_qty,
    p.top_province
FROM v_monthly_sku_sales s
JOIN dim_sku d ON s.sku_code = d.sku_code
LEFT JOIN v_sku_region_profile p ON s.sku_code = p.variant_key;
