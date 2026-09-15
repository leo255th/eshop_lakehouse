SET 'execution.runtime-mode' = 'batch';
SET 'table.exec.sink.upsert-materialize' = 'NONE';

SET 'table.local-time-zone' = 'Asia/Shanghai';

CREATE CATALOG paimon_eshop_10m WITH (
  'type'      = 'paimon',
  'warehouse' = 'hdfs:///paimon/warehouse/eshop_10m'
);

USE CATALOG paimon_eshop_10m;
USE dwd;

INSERT OVERWRITE dwd.fact_product_stock_per_day
SELECT
  TO_DATE(change_date, 'yyyyMMdd')                                   AS dt,
  change_date                                                        AS dt_str,
  product_id,
  CAST(SUM(CASE WHEN rn = 1   THEN open_stock  ELSE 0 END) AS INT)    AS day_open_stock,
  CAST(SUM(CASE WHEN rn = cnt THEN close_stock ELSE 0 END) AS INT)    AS day_end_stock,
  CAST(SUM(deduct_sum)    AS INT)                                    AS day_deduct_qty,
  CAST(SUM(replenish_sum) AS INT)                                    AS day_replenish_qty,
  CAST(SUM(net_change)    AS INT)                                    AS day_net_change,
  CAST(SUM(change_cnt)    AS INT)                                    AS change_cnt
FROM (
  SELECT
    change_date,
    product_id,
    stock_after - delta                     AS open_stock,
    stock_after                             AS close_stock,
    delta                                   AS net_change,
    CASE WHEN change_type = 'ORDER_DEDUCT' OR delta < 0 THEN delta ELSE 0 END AS deduct_sum,
    CASE WHEN change_type <> 'ORDER_DEDUCT' AND delta > 0 THEN delta ELSE 0 END AS replenish_sum,
    1                                       AS change_cnt,
    CAST(ROW_NUMBER() OVER (
      PARTITION BY product_id, change_date ORDER BY change_time
    ) AS INT)                               AS rn,
    CAST(COUNT(*) OVER (
      PARTITION BY product_id, change_date
    ) AS INT)                               AS cnt
  FROM (
    SELECT change_id, change_date, product_id, change_type, delta, stock_after, change_time
    FROM (
      SELECT *,
             CAST(ROW_NUMBER() OVER (
               PARTITION BY change_id ORDER BY change_time
             ) AS INT)                      AS dup_rn
      FROM ods.fact_stock_change
    ) d0
    WHERE dup_rn = 1
  ) src
) l1
GROUP BY change_date, product_id;
