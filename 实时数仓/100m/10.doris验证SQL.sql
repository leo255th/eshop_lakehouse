USE ads_eshop_100m;

SELECT 'Paimon fact_order_item' AS layer, COUNT(*) AS rows_cnt FROM paimon_eshop_100m.dwd.fact_order_item
UNION ALL SELECT 'Paimon fact_order_acc',  COUNT(*) FROM paimon_eshop_100m.dwd.fact_order_acc
UNION ALL SELECT 'Paimon dim_user',        COUNT(*) FROM paimon_eshop_100m.dwd.dim_user
UNION ALL SELECT 'Paimon dim_product',     COUNT(*) FROM paimon_eshop_100m.dwd.dim_product
UNION ALL SELECT 'Paimon dim_price_scd2',  COUNT(*) FROM paimon_eshop_100m.dwd.dim_product_price_scd2;

SELECT 'Doris fact_order_item' AS layer, COUNT(*) AS rows_cnt FROM dwd_eshop_100m.fact_order_item
UNION ALL SELECT 'Doris fact_order_acc',  COUNT(*) FROM dwd_eshop_100m.fact_order_acc
UNION ALL SELECT 'Doris dim_user',        COUNT(*) FROM dwd_eshop_100m.dim_user
UNION ALL SELECT 'Doris dim_product',     COUNT(*) FROM dwd_eshop_100m.dim_product
UNION ALL SELECT 'Doris dim_price_scd2',  COUNT(*) FROM dwd_eshop_100m.dim_product_price_scd2;

SELECT 'dws_trade_user_day'      AS table_name, COUNT(*) AS rows_cnt FROM dws_eshop_100m.dws_trade_user_day
UNION ALL SELECT 'dws_trade_product_day',   COUNT(*) FROM dws_eshop_100m.dws_trade_product_day
UNION ALL SELECT 'dws_trade_category_day',  COUNT(*) FROM dws_eshop_100m.dws_trade_category_day
UNION ALL SELECT 'dws_trade_province_day',  COUNT(*) FROM dws_eshop_100m.dws_trade_province_day
UNION ALL SELECT 'dws_user_lifetime',       COUNT(*) FROM dws_eshop_100m.dws_user_lifetime
UNION ALL SELECT 'dws_product_stock_day',   COUNT(*) FROM dws_eshop_100m.dws_product_stock_day;

SELECT 'ads_trade_overview_day'          AS table_name, COUNT(*) AS rows_cnt FROM ads_eshop_100m.ads_trade_overview_day
UNION ALL SELECT 'ads_order_funnel_day',          COUNT(*) FROM ads_eshop_100m.ads_order_funnel_day
UNION ALL SELECT 'ads_category_rank_day',         COUNT(*) FROM ads_eshop_100m.ads_category_rank_day
UNION ALL SELECT 'ads_user_rfm',                  COUNT(*) FROM ads_eshop_100m.ads_user_rfm
UNION ALL SELECT 'ads_gmv_caliber_compare',       COUNT(*) FROM ads_eshop_100m.ads_gmv_caliber_compare
UNION ALL SELECT 'ads_price_divergence_by_category', COUNT(*) FROM ads_eshop_100m.ads_price_divergence_by_category;

SELECT
  '下单GMV'                                                       AS metric,
  (SELECT CAST(SUM(total_amount) AS DECIMAL(18,2))
     FROM paimon_eshop_100m.dwd.fact_order_acc)                     AS dwd_value,
  (SELECT CAST(SUM(order_amount) AS DECIMAL(18,2))
     FROM dws_eshop_100m.dws_trade_user_day)                        AS dws_value,
  (SELECT CAST(SUM(order_amount) AS DECIMAL(18,2)) FROM ads_eshop_100m.ads_trade_overview_day) AS ads_value
UNION ALL
SELECT
  '口径A 快照价',
  (SELECT CAST(SUM(quantity * unit_price) AS DECIMAL(18,2)) FROM paimon_eshop_100m.dwd.fact_order_item),
  (SELECT CAST(SUM(sale_amount_snapshot) AS DECIMAL(18,2)) FROM dws_eshop_100m.dws_trade_product_day),
  (SELECT CAST(SUM(gmv_snapshot) AS DECIMAL(18,2)) FROM ads_eshop_100m.ads_gmv_caliber_compare)
UNION ALL
SELECT
  '订单数',
  (SELECT CAST(COUNT(*) AS DECIMAL(18,2)) FROM paimon_eshop_100m.dwd.fact_order_acc),
  (SELECT CAST(SUM(order_cnt) AS DECIMAL(18,2)) FROM dws_eshop_100m.dws_trade_user_day),
  (SELECT CAST(SUM(order_cnt) AS DECIMAL(18,2)) FROM ads_eshop_100m.ads_trade_overview_day);

SELECT
  CAST(SUM(gmv_snapshot) AS DECIMAL(18,2))                                        AS gmv_A_快照价,
  CAST(SUM(gmv_current_dim) AS DECIMAL(18,2))                                     AS gmv_B_当前维表价,
  CAST(SUM(gmv_scd2) AS DECIMAL(18,2))                                            AS gmv_C_SCD2版本价,
  CAST(SUM(gmv_net) AS DECIMAL(18,2))                                             AS gmv_净额,
  CAST(SUM(discount_total) AS DECIMAL(18,2))                                      AS 优惠总额,
  SUM(diverged_rows)                                                              AS 分叉行数,
  SUM(total_rows)                                                                 AS 明细总行数,
  CAST(SUM(diverged_rows) * 100.0 / SUM(total_rows) AS DECIMAL(10,4))             AS 分叉率_pct,
  CAST((SUM(gmv_current_dim) - SUM(gmv_snapshot)) * 100.0
        / SUM(gmv_snapshot) AS DECIMAL(10,6))                                     AS 额级偏差B_pct,
  CAST((SUM(gmv_scd2) - SUM(gmv_snapshot)) * 100.0
        / SUM(gmv_snapshot) AS DECIMAL(10,6))                                     AS 额级偏差C_pct,
  CAST(SUM(avg_abs_diff * total_rows) / SUM(total_rows) AS DECIMAL(18,4))         AS 行级平均绝对差
FROM ads_eshop_100m.ads_gmv_caliber_compare;

SELECT category 品类, total_rows 行数, diverged_rows 分叉行,
       diverged_pct 分叉率_pct, avg_abs_diff 平均绝对差,
       gmv_snapshot 快照GMV, gmv_current_dim 当前维GMV, gmv_bias_pct 额级偏差_pct
FROM ads_eshop_100m.ads_price_divergence_by_category
ORDER BY ABS(gmv_bias_pct) DESC;

SELECT dt, gmv_snapshot, gmv_current_dim, diff_pct_current, diverged_pct
FROM ads_eshop_100m.ads_gmv_caliber_compare
ORDER BY ABS(diff_pct_current) DESC
LIMIT 10;

SELECT
  SUM(order_cnt) AS 下单, SUM(paid_cnt) AS 支付, SUM(shipped_cnt) AS 发货,
  SUM(completed_cnt) AS 完成, SUM(cancelled_cnt) AS 取消,
  CAST(SUM(paid_cnt) * 100.0 / SUM(order_cnt) AS DECIMAL(10,4))     AS 支付率,
  CAST(SUM(completed_cnt) * 100.0 / SUM(shipped_cnt) AS DECIMAL(10,4)) AS 完成率,
  SUM(order_cnt) >= SUM(paid_cnt)      AS 检查_下单ge支付,
  SUM(paid_cnt)  >= SUM(completed_cnt) AS 检查_支付ge完成,
  MIN(paid_rate) >= 0 AND MAX(paid_rate) <= 100 AS 检查_比率合法
FROM ads_eshop_100m.ads_order_funnel_day;

SELECT COUNT(*) AS 超差天数 FROM (
  SELECT dt, SUM(gmv_share) AS s FROM ads_eshop_100m.ads_category_rank_day GROUP BY dt
) t WHERE ABS(s - 100) > 0.01;

SELECT COUNT(*) AS 排名异常天数 FROM (
  SELECT dt, COUNT(*) AS c, MAX(rank_no) AS mx, MIN(rank_no) AS mn
  FROM ads_eshop_100m.ads_category_rank_day GROUP BY dt
) t WHERE mx <> c OR mn <> 1;

SELECT COUNT(*) AS 总用户, COUNT(DISTINCT user_id) AS 去重用户,
       SUM(CASE WHEN r_score BETWEEN 1 AND 5
                 AND f_score BETWEEN 1 AND 5
                 AND m_score BETWEEN 1 AND 5 THEN 1 ELSE 0 END) AS 得分合法用户,
       SUM(CASE WHEN rfm_segment IS NULL THEN 1 ELSE 0 END)     AS 分层为空
FROM ads_eshop_100m.ads_user_rfm;

SELECT rfm_segment, COUNT(*) AS 用户数,
       CAST(AVG(recency_days) AS DECIMAL(10,1)) AS 平均R_天,
       CAST(AVG(frequency) AS DECIMAL(10,2))    AS 平均F_单,
       CAST(AVG(monetary) AS DECIMAL(12,2))     AS 平均M_元
FROM ads_eshop_100m.ads_user_rfm GROUP BY rfm_segment ORDER BY 用户数 DESC;

SELECT COUNT(*) AS aov不自洽天数 FROM ads_eshop_100m.ads_trade_overview_day
WHERE ABS(aov - pay_amount / NULLIF(pay_cnt, 0)) > 0.01;

SELECT
  (SELECT COUNT(*) FROM paimon_eshop_100m.dwd.fact_order_item)                 AS 明细原行数,
  (SELECT SUM(item_rows) FROM dws_eshop_100m.dws_trade_product_day)            AS DWS行数,
  (SELECT SUM(item_rows) FROM dws_eshop_100m.dws_trade_product_day)
    - (SELECT COUNT(*) FROM paimon_eshop_100m.dwd.fact_order_item)             AS 差异_应为0;

SELECT COUNT(*) AS 商品维重复行 FROM (
  SELECT product_id FROM paimon_eshop_100m.dwd.dim_product GROUP BY product_id HAVING COUNT(*) > 1
) t;

SELECT COUNT(*) AS 区间重叠数 FROM (
  SELECT s1.product_id
  FROM paimon_eshop_100m.dwd.dim_product_price_scd2 s1
  JOIN paimon_eshop_100m.dwd.dim_product_price_scd2 s2
    ON s1.product_id = s2.product_id
   AND s1.price_start_time < s2.price_start_time
   AND s1.price_end_time > s2.price_start_time
) t;

SELECT
  '明细行数' AS metric,
  (SELECT COUNT(*) FROM paimon_eshop_100m.dwd.fact_order_item) AS A_直查Paimon,
  (SELECT COUNT(*) FROM dwd_eshop_100m.fact_order_item)        AS B_Doris内表,
  (SELECT COUNT(*) FROM paimon_eshop_100m.dwd.fact_order_item)
    - (SELECT COUNT(*) FROM dwd_eshop_100m.fact_order_item)     AS 差异_应为0
UNION ALL
SELECT '订单数',
  (SELECT COUNT(*) FROM paimon_eshop_100m.dwd.fact_order_acc),
  (SELECT COUNT(*) FROM dwd_eshop_100m.fact_order_acc),
  (SELECT COUNT(*) FROM paimon_eshop_100m.dwd.fact_order_acc)
    - (SELECT COUNT(*) FROM dwd_eshop_100m.fact_order_acc);

EXPLAIN SELECT COUNT(*)
FROM dwd_eshop_100m.fact_order_item i
JOIN dwd_eshop_100m.dim_product p ON i.product_id = p.product_id
WHERE i.dt BETWEEN '2026-09-01' AND '2026-09-03'
  AND p.category = '手机数码';

-- SET runtime_filter_mode = 'OFF';
-- EXPLAIN ANALYZE SELECT ... ;
-- SET runtime_filter_mode = 'GLOBAL';

SHOW PROC "/colocation_group";

EXPLAIN SELECT COUNT(*)
FROM dwd_eshop_100m.fact_order_item i
JOIN dwd_eshop_100m.dim_product p ON i.product_id = p.product_id;

-- SET disable_colocate_join = true;
-- EXPLAIN SELECT ... ;
-- SET disable_colocate_join = false;

-- CREATE MATERIALIZED VIEW IF NOT EXISTS dwd_eshop_100m.mv_category_day AS
-- SELECT i.dt,
--        p.category,
--        COUNT(DISTINCT i.order_id)                     AS order_cnt,
--        SUM(i.quantity)                                AS item_qty,
--        CAST(SUM(i.quantity * i.unit_price) AS DECIMAL(18,2)) AS sale_amount
-- FROM dwd_eshop_100m.fact_order_item i
-- JOIN dwd_eshop_100m.dim_product p ON i.product_id = p.product_id
-- GROUP BY i.dt, p.category;
--   SELECT * FROM dwd_eshop_100m.mv_category_day ORDER BY dt, category LIMIT 10;
--   SHOW MATERIALIZED VIEWS FROM dwd_eshop_100m;

SELECT
  (SELECT CAST(SUM(order_amount) AS DECIMAL(18,2)) FROM dws_eshop_100m.dws_trade_user_day) AS 下单GMV_重跑后,
  (SELECT CAST(SUM(gmv_snapshot) AS DECIMAL(18,2)) FROM ads_eshop_100m.ads_gmv_caliber_compare) AS 快照GMV_重跑后,
  (SELECT CAST(SUM(order_cnt) AS DECIMAL(18,2)) FROM ads_eshop_100m.ads_trade_overview_day) AS 订单数_重跑后;
