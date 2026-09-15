SET 'execution.runtime-mode' = 'batch';
SET 'table.local-time-zone' = 'Asia/Shanghai';

CREATE CATALOG paimon_eshop_10m WITH (
  'type'      = 'paimon',
  'warehouse' = 'hdfs:///paimon/warehouse/eshop_10m'
);

USE CATALOG paimon_eshop_10m;
USE dwd;

--           SELECT COUNT(*) FROM eshop_10m.fact_product_price_change;
SELECT COUNT(*)                              AS ods_rows,
       COUNT(DISTINCT change_id)             AS distinct_events,
       COUNT(*) - COUNT(DISTINCT change_id)  AS duplicated_rows,
       COUNT(DISTINCT product_id)            AS products,
       COUNT(DISTINCT change_date)           AS days,
       MIN(change_time)                      AS min_t,
       MAX(change_time)                      AS max_t
FROM ods.fact_product_price_change;

SELECT product_id, COUNT(*) AS current_cnt
FROM dwd.dim_product_price_scd2
WHERE is_current = 1
GROUP BY product_id
HAVING COUNT(*) <> 1;

SELECT product_id, version_no, price_end_time, next_start
FROM (
  SELECT product_id, version_no, price_end_time,
         LEAD(price_start_time) OVER (PARTITION BY product_id ORDER BY price_start_time) AS next_start
  FROM dwd.dim_product_price_scd2
) t
WHERE next_start IS NOT NULL AND price_end_time <> next_start;

SELECT product_id, version_no
FROM (
  SELECT product_id, version_no, price,
         LAG(price) OVER (PARTITION BY product_id ORDER BY price_start_time) AS prev_price
  FROM dwd.dim_product_price_scd2
) t
WHERE version_no > 1 AND price = prev_price;

SELECT (SELECT COUNT(*) FROM ods.fact_product_price_change)              AS events_n,
       (SELECT COUNT(DISTINCT product_id) FROM ods.fact_product_price_change) AS products_p,
       2 * (SELECT COUNT(*) FROM ods.fact_product_price_change)
         - (SELECT COUNT(DISTINCT product_id) FROM ods.fact_product_price_change) AS expected_rows,
       (SELECT COUNT(*) FROM dwd.dim_product_price_scd2)                 AS actual_rows,
       (SELECT SUM(CAST(is_current AS INT)) FROM dwd.dim_product_price_scd2) AS current_rows;

SELECT
  COUNT(*)                                                                   AS compared_rows,
  SUM(CASE WHEN ABS(s.price - i.unit_price) < 0.01 THEN 1 ELSE 0 END)        AS matched,
  SUM(CASE WHEN ABS(s.price - i.unit_price) >= 0.01 THEN 1 ELSE 0 END)       AS mismatched,
  ROUND(SUM(CASE WHEN ABS(s.price - i.unit_price) < 0.01 THEN 1 ELSE 0 END)
        * 100.0 / COUNT(*), 2)                                               AS match_rate_pct
FROM dwd.fact_order_item i
JOIN dwd.dim_product_price_scd2 s
  ON s.product_id = i.product_id
 AND i.create_time >= s.price_start_time
 AND i.create_time <  s.price_end_time;

SELECT 'A_快照价×数量(毛)' AS calib, CAST(SUM(i.quantity * i.unit_price) AS DECIMAL(18,2)) AS gmv
FROM dwd.fact_order_item i
UNION ALL
SELECT 'B_当前维表价×数量(毛)', CAST(SUM(i.quantity * p.price) AS DECIMAL(18,2))
FROM dwd.fact_order_item i
JOIN dwd.dim_product p ON p.product_id = i.product_id
UNION ALL
SELECT 'C_SCD2版本价×数量(毛)', CAST(SUM(i.quantity * s.price) AS DECIMAL(18,2))
FROM dwd.fact_order_item i
JOIN dwd.dim_product_price_scd2 s
  ON s.product_id = i.product_id
 AND i.create_time >= s.price_start_time
 AND i.create_time <  s.price_end_time;

SELECT CAST(SUM(subtotal) AS DECIMAL(18,2))                    AS gmv_gross,
       CAST(SUM(subtotal - discount_amount) AS DECIMAL(18,2))  AS gmv_net,
       CAST(SUM(discount_amount) AS DECIMAL(18,2))             AS discount_total
FROM dwd.fact_order_item;

SELECT CAST(SUM(CASE WHEN ABS(i.unit_price - p.price) > 0.01 THEN 1 ELSE 0 END) AS BIGINT) AS diverged_rows,
       CAST(COUNT(*) AS BIGINT)                                                            AS total_rows,
       CAST(ROUND(SUM(i.quantity * p.price) / SUM(i.quantity * i.unit_price) * 100 - 100, 4) AS DECIMAL(10,4)) AS gmv_bias_pct
FROM dwd.fact_order_item i
JOIN dwd.dim_product p ON p.product_id = i.product_id;

SELECT
  COUNT(*)                                                            AS total_items,
  SUM(CASE WHEN ABS(i.unit_price - p.price) > 0.01 THEN 1 ELSE 0 END) AS diverged,
  ROUND(SUM(CASE WHEN ABS(i.unit_price - p.price) > 0.01 THEN 1 ELSE 0 END)
        * 100.0 / COUNT(*), 2)                                        AS diverged_pct,
  ROUND(AVG(ABS(i.unit_price - p.price)), 2)                          AS avg_abs_diff
FROM dwd.fact_order_item i
JOIN dwd.dim_product p ON p.product_id = i.product_id;

SELECT
  COUNT(*)                                                                   AS order_cnt,
  SUM(CAST(is_paid      AS INT))                                             AS paid_cnt,
  SUM(CAST(is_shipped   AS INT))                                             AS shipped_cnt,
  SUM(CAST(is_completed AS INT))                                             AS completed_cnt,
  SUM(CAST(is_cancelled AS INT))                                             AS cancelled_cnt,
  ROUND(SUM(CAST(is_paid      AS INT)) * 100.0 / COUNT(*), 2)                AS paid_rate_pct,
  ROUND(SUM(CAST(is_shipped   AS INT)) * 100.0 / NULLIF(SUM(CAST(is_paid      AS INT)), 0), 2) AS ship_rate_pct,
  ROUND(SUM(CAST(is_completed AS INT)) * 100.0 / NULLIF(SUM(CAST(is_shipped   AS INT)), 0), 2) AS complete_rate_pct,
  ROUND(AVG(pay_duration_sec), 0)                             AS avg_pay_sec,
  ROUND(AVG(ship_duration_sec), 0)                            AS avg_ship_sec,
  ROUND(AVG(receive_duration_sec), 0)                         AS avg_receive_sec
FROM dwd.fact_order_acc;

SELECT COUNT(*)                                                      AS rows_total,
       COUNT(DISTINCT dt_str)                                        AS days,
       COUNT(DISTINCT product_id)                                    AS products,
       MIN(dt)                                                       AS min_dt,
       MAX(dt)                                                       AS max_dt,
       SUM(CASE WHEN day_open_stock < 0 THEN 1 ELSE 0 END)           AS negative_open,
       SUM(CASE WHEN day_end_stock  < 0 THEN 1 ELSE 0 END)           AS negative_end,
       SUM(CASE WHEN day_net_change <> day_end_stock - day_open_stock THEN 1 ELSE 0 END) AS broken_balance
FROM dwd.fact_product_stock_per_day;
