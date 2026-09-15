USE ads_eshop_10m;

-- SET @data_end = DATE '2026-09-13';

TRUNCATE TABLE ads_eshop_10m.ads_trade_overview_day;
INSERT INTO ads_eshop_10m.ads_trade_overview_day
SELECT
  dt,
  SUM(order_cnt)                                                          AS order_cnt,
  CAST(SUM(order_amount) AS DECIMAL(18,2))                                AS order_amount,
  SUM(pay_cnt)                                                            AS pay_cnt,
  CAST(SUM(pay_amount) AS DECIMAL(18,2))                                  AS pay_amount,
  SUM(complete_cnt)                                                       AS complete_cnt,
  CAST(SUM(complete_amount) AS DECIMAL(18,2))                             AS complete_amount,
  SUM(cancel_cnt)                                                         AS cancel_cnt,
  CAST(SUM(cancel_cnt) * 100.0 / NULLIF(SUM(order_cnt), 0) AS DECIMAL(10,4))       AS cancel_rate,
  COUNT(*)                                                                AS buyer_cnt,
  SUM(item_qty)                                                           AS item_qty,
  CAST(SUM(pay_amount) / NULLIF(SUM(pay_cnt), 0)   AS DECIMAL(18,2))      AS aov,
  CAST(SUM(pay_amount) / NULLIF(SUM(item_qty), 0)  AS DECIMAL(18,2))      AS unit_price_avg,
  NOW()                                                                   AS etl_time
FROM dws_eshop_10m.dws_trade_user_day
GROUP BY dt;

TRUNCATE TABLE ads_eshop_10m.ads_order_funnel_day;
INSERT INTO ads_eshop_10m.ads_order_funnel_day
SELECT
  dt,
  SUM(order_cnt)                                                          AS order_cnt,
  SUM(pay_cnt)                                                            AS paid_cnt,
  SUM(shipped_cnt)                                                        AS shipped_cnt,
  SUM(complete_cnt)                                                       AS completed_cnt,
  SUM(cancel_cnt)                                                         AS cancelled_cnt,
  CAST(SUM(pay_cnt)      * 100.0 / NULLIF(SUM(order_cnt), 0)  AS DECIMAL(10,4))  AS paid_rate,
  CAST(SUM(shipped_cnt)  * 100.0 / NULLIF(SUM(pay_cnt), 0)    AS DECIMAL(10,4))  AS ship_rate,
  CAST(SUM(complete_cnt) * 100.0 / NULLIF(SUM(shipped_cnt), 0) AS DECIMAL(10,4)) AS complete_rate,
  CAST(SUM(pay_duration_sum)     / NULLIF(SUM(pay_cnt), 0)      AS DECIMAL(18,2)) AS avg_pay_sec,
  CAST(SUM(ship_duration_sum)    / NULLIF(SUM(shipped_cnt), 0)  AS DECIMAL(18,2)) AS avg_ship_sec,
  CAST(SUM(receive_duration_sum) / NULLIF(SUM(complete_cnt), 0) AS DECIMAL(18,2)) AS avg_receive_sec,
  NOW()                                                                   AS etl_time
FROM dws_eshop_10m.dws_trade_user_day
GROUP BY dt;

TRUNCATE TABLE ads_eshop_10m.ads_category_rank_day;
INSERT INTO ads_eshop_10m.ads_category_rank_day
SELECT
  dt,
  category,
  rank_no,
  sale_amount,
  item_qty,
  order_cnt,
  CAST(sale_amount * 100.0 / NULLIF(day_total, 0) AS DECIMAL(10,4))       AS gmv_share,
  NOW()                                                                   AS etl_time
FROM (
  SELECT
    dt,
    category,
    CAST(ROW_NUMBER() OVER (PARTITION BY dt ORDER BY sale_amount DESC) AS INT) AS rank_no,
    sale_amount,
    item_qty,
    order_cnt,
    SUM(sale_amount) OVER (PARTITION BY dt)                               AS day_total
  FROM dws_eshop_10m.dws_trade_category_day
) t;

TRUNCATE TABLE ads_eshop_10m.ads_user_rfm;
INSERT INTO ads_eshop_10m.ads_user_rfm
SELECT
  user_id,
  recency_days,
  frequency,
  monetary,
  r_score,
  f_score,
  m_score,
  CASE
    WHEN r_score >= 4 AND f_score >= 4 AND m_score >= 4 THEN '重要价值客户'
    WHEN r_score <  4 AND f_score >= 4 AND m_score >= 4 THEN '重要保持客户'
    WHEN r_score >= 4 AND f_score <  4                  THEN '重要发展客户'
    WHEN r_score <  4 AND f_score >= 4 AND m_score <  4 THEN '重要挽留客户'
    ELSE '一般客户'
  END                                                                     AS rfm_segment,
  NOW()                                                                   AS etl_time
FROM (
  SELECT
    user_id,
    DATEDIFF(DATE '2026-09-13', last_order_date)                          AS recency_days,
    CAST(order_cnt AS INT)                                                AS frequency,
    CAST(order_amount AS DECIMAL(18,2))                                   AS monetary,
    CAST(6 - NTILE(5) OVER (ORDER BY DATEDIFF(DATE '2026-09-13', last_order_date) ASC)  AS TINYINT) AS r_score,
    CAST(NTILE(5)     OVER (ORDER BY order_cnt ASC)                       AS TINYINT) AS f_score,
    CAST(NTILE(5)     OVER (ORDER BY order_amount ASC)                    AS TINYINT) AS m_score
  FROM dws_eshop_10m.dws_user_lifetime
) t;

TRUNCATE TABLE ads_eshop_10m.ads_gmv_caliber_compare;
INSERT INTO ads_eshop_10m.ads_gmv_caliber_compare
SELECT
  p.dt,
  p.gmv_snapshot,
  p.gmv_current_dim,
  p.gmv_scd2,
  u.gmv_net,
  u.discount_total,
  CAST(p.gmv_current_dim - p.gmv_snapshot AS DECIMAL(18,2))               AS diff_current_vs_snapshot,
  CAST((p.gmv_current_dim - p.gmv_snapshot) * 100.0 / NULLIF(p.gmv_snapshot, 0) AS DECIMAL(12,6)) AS diff_pct_current,
  CAST(p.gmv_scd2 - p.gmv_snapshot AS DECIMAL(18,2))                      AS diff_scd2_vs_snapshot,
  CAST((p.gmv_scd2 - p.gmv_snapshot) * 100.0 / NULLIF(p.gmv_snapshot, 0) AS DECIMAL(12,6)) AS diff_pct_scd2,
  p.diverged_rows,
  p.total_rows,
  CAST(p.diverged_rows * 100.0 / NULLIF(p.total_rows, 0) AS DECIMAL(12,6)) AS diverged_pct,
  p.avg_abs_diff,
  NOW()                                                                   AS etl_time
FROM (
  SELECT
    dt,
    CAST(SUM(sale_amount_snapshot)    AS DECIMAL(18,2)) AS gmv_snapshot,
    CAST(SUM(sale_amount_current_dim) AS DECIMAL(18,2)) AS gmv_current_dim,
    CAST(SUM(sale_amount_scd2)        AS DECIMAL(18,2)) AS gmv_scd2,
    SUM(diverged_rows)                                  AS diverged_rows,
    SUM(item_rows)                                      AS total_rows,
    CAST(SUM(avg_abs_diff * item_rows) / NULLIF(SUM(item_rows), 0) AS DECIMAL(18,4)) AS avg_abs_diff
  FROM dws_eshop_10m.dws_trade_product_day
  GROUP BY dt
) p
LEFT JOIN (
  SELECT dt,
         CAST(SUM(order_amount) AS DECIMAL(18,2))    AS gmv_net,
         CAST(SUM(discount_amount) AS DECIMAL(18,2)) AS discount_total
  FROM dws_eshop_10m.dws_trade_user_day
  GROUP BY dt
) u ON u.dt = p.dt;

TRUNCATE TABLE ads_eshop_10m.ads_price_divergence_by_category;
INSERT INTO ads_eshop_10m.ads_price_divergence_by_category
SELECT
  category,
  SUM(item_rows)                                                          AS total_rows,
  SUM(diverged_rows)                                                      AS diverged_rows,
  CAST(SUM(diverged_rows) * 100.0 / NULLIF(SUM(item_rows), 0) AS DECIMAL(12,6)) AS diverged_pct,
  CAST(SUM(avg_abs_diff * item_rows) / NULLIF(SUM(item_rows), 0) AS DECIMAL(18,4)) AS avg_abs_diff,
  CAST(SUM(sale_amount) AS DECIMAL(18,2))                                 AS gmv_snapshot,
  CAST(SUM(sale_amount_current_dim) AS DECIMAL(18,2))                     AS gmv_current_dim,
  CAST((SUM(sale_amount_current_dim) - SUM(sale_amount)) * 100.0 / NULLIF(SUM(sale_amount), 0) AS DECIMAL(12,6)) AS gmv_bias_pct,
  NOW()                                                                   AS etl_time
FROM dws_eshop_10m.dws_trade_category_day
GROUP BY category;

SELECT 'ads_trade_overview_day'          AS table_name, COUNT(*) AS rows_cnt FROM ads_eshop_10m.ads_trade_overview_day
UNION ALL SELECT 'ads_order_funnel_day',          COUNT(*) FROM ads_eshop_10m.ads_order_funnel_day
UNION ALL SELECT 'ads_category_rank_day',         COUNT(*) FROM ads_eshop_10m.ads_category_rank_day
UNION ALL SELECT 'ads_user_rfm',                  COUNT(*) FROM ads_eshop_10m.ads_user_rfm
UNION ALL SELECT 'ads_gmv_caliber_compare',       COUNT(*) FROM ads_eshop_10m.ads_gmv_caliber_compare
UNION ALL SELECT 'ads_price_divergence_by_category', COUNT(*) FROM ads_eshop_10m.ads_price_divergence_by_category;
