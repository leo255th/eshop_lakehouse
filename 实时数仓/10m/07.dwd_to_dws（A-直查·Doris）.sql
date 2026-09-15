--             SELECT COUNT(*) FROM paimon_eshop_10m.dwd.fact_order_item;

SET enable_profile = false;

USE dws_eshop_10m;

TRUNCATE TABLE dws_eshop_10m.dws_trade_user_day;
INSERT INTO dws_eshop_10m.dws_trade_user_day
SELECT
  STR_TO_DATE(order_date, '%Y%m%d')                             AS dt,
  user_id,
  COUNT(*)                                                      AS order_cnt,
  SUM(item_count)                                               AS item_qty,
  CAST(SUM(total_amount) AS DECIMAL(18,2))                      AS order_amount,
  SUM(CASE WHEN is_paid      = 1 THEN 1 ELSE 0 END)             AS pay_cnt,
  CAST(SUM(CASE WHEN is_paid      = 1 THEN total_amount ELSE 0 END) AS DECIMAL(18,2)) AS pay_amount,
  SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END)             AS complete_cnt,
  SUM(CASE WHEN is_shipped   = 1 THEN 1 ELSE 0 END)             AS shipped_cnt,
  CAST(SUM(CASE WHEN is_shipped   = 1 THEN total_amount ELSE 0 END) AS DECIMAL(18,2)) AS shipped_amount,
  CAST(SUM(CASE WHEN is_completed = 1 THEN total_amount ELSE 0 END) AS DECIMAL(18,2)) AS complete_amount,
  SUM(CASE WHEN is_cancelled = 1 THEN 1 ELSE 0 END)             AS cancel_cnt,
  CAST(SUM(CASE WHEN is_cancelled = 1 THEN total_amount ELSE 0 END) AS DECIMAL(18,2)) AS cancel_amount,
  CAST(SUM(discount_amount) AS DECIMAL(18,2))                   AS discount_amount,
  SUM(pay_duration_sec)                                         AS pay_duration_sum,
  SUM(ship_duration_sec)                                        AS ship_duration_sum,
  SUM(receive_duration_sec)                                     AS receive_duration_sum,
  MIN(order_time)                                               AS first_order_time,
  MAX(order_time)                                               AS last_order_time,
  NOW()                                                         AS etl_time
FROM paimon_eshop_10m.dwd.fact_order_acc
GROUP BY 1, 2;

TRUNCATE TABLE dws_eshop_10m.dws_trade_product_day;
INSERT INTO dws_eshop_10m.dws_trade_product_day
SELECT
  STR_TO_DATE(i.order_date, '%Y%m%d')                           AS dt,
  i.product_id,
  COUNT(DISTINCT i.order_id)                                    AS order_cnt,
  COUNT(*)                                                      AS item_rows,
  SUM(i.quantity)                                               AS item_qty,
  COUNT(DISTINCT i.user_id)                                     AS buyer_cnt,
  CAST(SUM(i.quantity * i.unit_price) AS DECIMAL(18,2))         AS sale_amount_snapshot,
  CAST(SUM(i.quantity * p.price) AS DECIMAL(18,2))              AS sale_amount_current_dim,
  CAST(SUM(i.quantity * s.price) AS DECIMAL(18,2))              AS sale_amount_scd2,
  CAST(SUM(i.net_amount) AS DECIMAL(18,2))                      AS sale_amount_net,
  SUM(CASE WHEN ABS(i.unit_price - p.price) > 0.01 THEN 1 ELSE 0 END) AS diverged_rows,
  CAST(AVG(ABS(i.unit_price - p.price)) AS DECIMAL(18,4))       AS avg_abs_diff,
  NOW()                                                         AS etl_time
FROM paimon_eshop_10m.dwd.fact_order_item i
LEFT JOIN paimon_eshop_10m.dwd.dim_product p
       ON p.product_id = i.product_id
LEFT JOIN paimon_eshop_10m.dwd.dim_product_price_scd2 s
       ON s.product_id = i.product_id
      AND i.create_time >= s.price_start_time
      AND i.create_time <  s.price_end_time
GROUP BY 1, 2;

TRUNCATE TABLE dws_eshop_10m.dws_trade_category_day;
INSERT INTO dws_eshop_10m.dws_trade_category_day
SELECT
  STR_TO_DATE(i.order_date, '%Y%m%d')                           AS dt,
  p.category,
  COUNT(DISTINCT i.order_id)                                    AS order_cnt,
  COUNT(*)                                                      AS item_rows,
  SUM(i.quantity)                                               AS item_qty,
  COUNT(DISTINCT i.user_id)                                     AS buyer_cnt,
  COUNT(DISTINCT i.product_id)                                  AS product_cnt,
  CAST(SUM(i.quantity * i.unit_price) AS DECIMAL(18,2))         AS sale_amount,
  CAST(SUM(i.quantity * p.price) AS DECIMAL(18,2))              AS sale_amount_current_dim,
  SUM(CASE WHEN ABS(i.unit_price - p.price) > 0.01 THEN 1 ELSE 0 END) AS diverged_rows,
  CAST(AVG(ABS(i.unit_price - p.price)) AS DECIMAL(18,4))       AS avg_abs_diff,
  NOW()                                                         AS etl_time
FROM paimon_eshop_10m.dwd.fact_order_item i
JOIN paimon_eshop_10m.dwd.dim_product p ON p.product_id = i.product_id
GROUP BY 1, 2;

TRUNCATE TABLE dws_eshop_10m.dws_trade_province_day;
INSERT INTO dws_eshop_10m.dws_trade_province_day
SELECT
  STR_TO_DATE(o.order_date, '%Y%m%d')                           AS dt,
  u.province,
  COUNT(*)                                                      AS order_cnt,
  COUNT(DISTINCT o.user_id)                                     AS buyer_cnt,
  CAST(SUM(o.total_amount) AS DECIMAL(18,2))                    AS order_amount,
  CAST(SUM(CASE WHEN o.is_paid = 1 THEN o.total_amount ELSE 0 END) AS DECIMAL(18,2)) AS pay_amount,
  NOW()                                                         AS etl_time
FROM paimon_eshop_10m.dwd.fact_order_acc o
JOIN paimon_eshop_10m.dwd.dim_user u ON u.user_id = o.user_id
GROUP BY 1, 2;

TRUNCATE TABLE dws_eshop_10m.dws_user_lifetime;
INSERT INTO dws_eshop_10m.dws_user_lifetime
SELECT
  user_id,
  MIN(STR_TO_DATE(order_date, '%Y%m%d'))                        AS first_order_date,
  MAX(STR_TO_DATE(order_date, '%Y%m%d'))                        AS last_order_date,
  COUNT(*)                                                      AS order_cnt,
  SUM(CASE WHEN is_paid      = 1 THEN 1 ELSE 0 END)             AS pay_cnt,
  SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END)             AS complete_cnt,
  SUM(CASE WHEN is_cancelled = 1 THEN 1 ELSE 0 END)             AS cancel_cnt,
  CAST(SUM(total_amount) AS DECIMAL(18,2))                      AS order_amount,
  CAST(SUM(CASE WHEN is_paid = 1 THEN total_amount ELSE 0 END) AS DECIMAL(18,2)) AS pay_amount,
  SUM(item_count)                                               AS item_qty,
  COUNT(DISTINCT order_date)                                    AS active_days,
  NOW()                                                         AS etl_time
FROM paimon_eshop_10m.dwd.fact_order_acc
GROUP BY user_id;

TRUNCATE TABLE dws_eshop_10m.dws_product_stock_day;
INSERT INTO dws_eshop_10m.dws_product_stock_day
SELECT
  s.dt,
  s.product_id,
  s.day_open_stock,
  s.day_end_stock,
  s.day_deduct_qty,
  s.day_replenish_qty,
  s.day_net_change,
  s.change_cnt,
  NOW()                                                         AS etl_time
FROM paimon_eshop_10m.dwd.fact_product_stock_per_day s;

SELECT 'dws_trade_user_day'       AS table_name, COUNT(*) AS rows_cnt FROM dws_eshop_10m.dws_trade_user_day
UNION ALL SELECT 'dws_trade_product_day',   COUNT(*) FROM dws_eshop_10m.dws_trade_product_day
UNION ALL SELECT 'dws_trade_category_day',  COUNT(*) FROM dws_eshop_10m.dws_trade_category_day
UNION ALL SELECT 'dws_trade_province_day',  COUNT(*) FROM dws_eshop_10m.dws_trade_province_day
UNION ALL SELECT 'dws_user_lifetime',       COUNT(*) FROM dws_eshop_10m.dws_user_lifetime
UNION ALL SELECT 'dws_product_stock_day',   COUNT(*) FROM dws_eshop_10m.dws_product_stock_day;

-- INSERT INTO dws_eshop_10m.dws_trade_user_day
-- SELECT STR_TO_DATE(order_date,'%Y%m%d'), user_id, ... FROM paimon_eshop_10m.dwd.fact_order_acc
-- WHERE order_date = DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 DAY), '%Y%m%d')
-- GROUP BY 1,2;
