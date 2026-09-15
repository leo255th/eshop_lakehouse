SET 'execution.runtime-mode' = 'streaming';
SET 'table.exec.sink.upsert-materialize' = 'NONE';

SET 'state.backend' = 'rocksdb';
SET 'state.backend.incremental' = 'true';
SET 'parallelism.default' = '1';

SET 'execution.checkpointing.interval' = '10s';
SET 'state.checkpoints.dir' = 'hdfs:///flink/checkpoints';

SET 'table.local-time-zone' = 'Asia/Shanghai';

CREATE CATALOG paimon_eshop_1m WITH (
  'type'      = 'paimon',
  'warehouse' = 'hdfs:///paimon/warehouse/eshop_1m'
);

USE CATALOG paimon_eshop_1m;
USE dwd;

INSERT INTO dwd.dim_date
SELECT
  dt,
  CAST(YEAR(ts) AS INT)                                              AS dt_year,
  CAST(QUARTER(ts) AS INT)                                           AS dt_quarter,
  CAST(MONTH(ts) AS INT)                                             AS dt_month,
  CAST(DAYOFMONTH(ts) AS INT)                                        AS dt_day,
  CAST(WEEK(ts) AS INT)                                              AS week_of_year,
  CAST(IF(DAYOFWEEK(ts) = 1, 7, DAYOFWEEK(ts) - 1) AS INT)           AS day_of_week,
  CAST(IF(DAYOFWEEK(ts) IN (1, 7), 1, 0) AS TINYINT)                 AS is_weekend,
  DATE_FORMAT(ts, 'yyyy-MM')                                         AS year_month,
  CONCAT(
    CAST(YEAR(ts) AS STRING), '-W',
    LPAD(CAST(WEEK(ts) AS STRING), 2, '0')
  )                                                                  AS year_week,
  DATE_FORMAT(ts, 'yyyyMMdd')                                        AS date_str
FROM (
  SELECT
    d.dt,
    CAST(d.dt AS TIMESTAMP) AS ts
  FROM (
    SELECT DATE '2026-08-01' AS dt UNION ALL SELECT DATE '2026-08-02' AS dt UNION ALL SELECT DATE '2026-08-03' AS dt UNION ALL
    SELECT DATE '2026-08-04' AS dt UNION ALL SELECT DATE '2026-08-05' AS dt UNION ALL SELECT DATE '2026-08-06' AS dt UNION ALL
    SELECT DATE '2026-08-07' AS dt UNION ALL SELECT DATE '2026-08-08' AS dt UNION ALL SELECT DATE '2026-08-09' AS dt UNION ALL
    SELECT DATE '2026-08-10' AS dt UNION ALL SELECT DATE '2026-08-11' AS dt UNION ALL SELECT DATE '2026-08-12' AS dt UNION ALL
    SELECT DATE '2026-08-13' AS dt UNION ALL SELECT DATE '2026-08-14' AS dt UNION ALL SELECT DATE '2026-08-15' AS dt UNION ALL
    SELECT DATE '2026-08-16' AS dt UNION ALL SELECT DATE '2026-08-17' AS dt UNION ALL SELECT DATE '2026-08-18' AS dt UNION ALL
    SELECT DATE '2026-08-19' AS dt UNION ALL SELECT DATE '2026-08-20' AS dt UNION ALL SELECT DATE '2026-08-21' AS dt UNION ALL
    SELECT DATE '2026-08-22' AS dt UNION ALL SELECT DATE '2026-08-23' AS dt UNION ALL SELECT DATE '2026-08-24' AS dt UNION ALL
    SELECT DATE '2026-08-25' AS dt UNION ALL SELECT DATE '2026-08-26' AS dt UNION ALL SELECT DATE '2026-08-27' AS dt UNION ALL
    SELECT DATE '2026-08-28' AS dt UNION ALL SELECT DATE '2026-08-29' AS dt UNION ALL SELECT DATE '2026-08-30' AS dt UNION ALL
    SELECT DATE '2026-08-31' AS dt UNION ALL SELECT DATE '2026-09-01' AS dt UNION ALL SELECT DATE '2026-09-02' AS dt UNION ALL
    SELECT DATE '2026-09-03' AS dt UNION ALL SELECT DATE '2026-09-04' AS dt UNION ALL SELECT DATE '2026-09-05' AS dt UNION ALL
    SELECT DATE '2026-09-06' AS dt UNION ALL SELECT DATE '2026-09-07' AS dt UNION ALL SELECT DATE '2026-09-08' AS dt UNION ALL
    SELECT DATE '2026-09-09' AS dt UNION ALL SELECT DATE '2026-09-10' AS dt UNION ALL SELECT DATE '2026-09-11' AS dt UNION ALL
    SELECT DATE '2026-09-12' AS dt UNION ALL SELECT DATE '2026-09-13' AS dt UNION ALL SELECT DATE '2026-09-14' AS dt UNION ALL
    SELECT DATE '2026-09-15' AS dt UNION ALL SELECT DATE '2026-09-16' AS dt UNION ALL SELECT DATE '2026-09-17' AS dt UNION ALL
    SELECT DATE '2026-09-18' AS dt UNION ALL SELECT DATE '2026-09-19' AS dt UNION ALL SELECT DATE '2026-09-20' AS dt UNION ALL
    SELECT DATE '2026-09-21' AS dt UNION ALL SELECT DATE '2026-09-22' AS dt UNION ALL SELECT DATE '2026-09-23' AS dt UNION ALL
    SELECT DATE '2026-09-24' AS dt UNION ALL SELECT DATE '2026-09-25' AS dt UNION ALL SELECT DATE '2026-09-26' AS dt UNION ALL
    SELECT DATE '2026-09-27' AS dt UNION ALL SELECT DATE '2026-09-28' AS dt UNION ALL SELECT DATE '2026-09-29' AS dt UNION ALL
    SELECT DATE '2026-09-30' AS dt UNION ALL SELECT DATE '2026-10-01' AS dt
  ) AS d
) AS t;

INSERT INTO dwd.dim_user
SELECT
  user_id,
  username,
  phone,
  email,
  province,
  city,
  user_level,
  CAST(CASE user_level WHEN 1 THEN '普通' WHEN 2 THEN '银牌' WHEN 3 THEN '金牌'
                       ELSE '未知' END AS VARCHAR(8))    AS user_level_name,
  status,
  register_channel,
  CAST(CASE WHEN first_order_time IS NOT NULL THEN 1 ELSE 0 END AS TINYINT) AS is_new_user,
  first_order_time,
  create_time,
  update_time
FROM ods.dim_user
WHERE is_deleted = 0;

INSERT INTO dwd.dim_product
SELECT
  product_id,
  product_name,
  category,
  brand,
  price,
  CAST(CASE
    WHEN price <  100  THEN '低价(0-100)'
    WHEN price < 1000  THEN '中价(100-1000)'
    WHEN price < 5000  THEN '高价(1000-5000)'
    ELSE                    '超高价(5000+)'
  END AS VARCHAR(16))                                       AS price_band,
  cost_price,
  CASE WHEN price > 0
       THEN CAST((price - cost_price) / price AS DECIMAL(5,4))
       ELSE CAST(0 AS DECIMAL(5,4))
  END                                                       AS gross_margin,
  stock,
  status,
  create_time,
  update_time
FROM ods.dim_product
WHERE is_deleted = 0;

INSERT INTO dwd.dim_product_price_scd2
WITH v AS (
  SELECT
    product_id,
    new_price,
    change_type,
    change_time,
    version_no,
    LAG(change_time) OVER (
      PARTITION BY product_id ORDER BY pt
    )                                                        AS prev_start,
    LAG(new_price) OVER (
      PARTITION BY product_id ORDER BY pt
    )                                                        AS prev_price
  FROM (
    SELECT
      product_id,
      new_price,
      change_type,
      change_time,
      pt,
      CAST(ROW_NUMBER() OVER (
        PARTITION BY product_id ORDER BY pt
      ) AS INT)                                              AS version_no
    FROM (
      SELECT
        change_id, product_id, old_price, new_price,
        change_type, change_time, pt,
        CAST(ROW_NUMBER() OVER (
          PARTITION BY change_id ORDER BY pt
        ) AS INT)                                              AS dup_rn
      FROM (
        SELECT *, PROCTIME() AS pt
        FROM ods.fact_product_price_change
        /*+ OPTIONS('scan.plan-sort-partition' = 'true') */
      ) p0
    ) d0
    WHERE dup_rn = 1 AND change_type <> 'FINAL'
  ) l1
)
SELECT
  product_id,
  DATE_FORMAT(prev_start, 'yyyyMMdd')                        AS dt,
  prev_price                                                 AS price,
  prev_start                                                 AS price_start_time,
  change_time                                                AS price_end_time,
  CAST(0 AS TINYINT)                                         AS is_current,
  version_no - 1                                             AS version_no,
  change_type                                                AS change_type,
  version_no                                                 AS event_seq
FROM v
WHERE prev_start IS NOT NULL
UNION ALL
SELECT
  product_id,
  DATE_FORMAT(change_time, 'yyyyMMdd')                       AS dt,
  new_price                                                  AS price,
  change_time                                                AS price_start_time,
  TIMESTAMP '9999-12-31 23:59:59'                            AS price_end_time,
  CAST(1 AS TINYINT)                                         AS is_current,
  version_no                                                 AS version_no,
  change_type                                                AS change_type,
  version_no                                                 AS event_seq
FROM v;

INSERT INTO dwd.fact_order_item
SELECT
  i.item_id,
  i.order_date,
  i.order_id,
  o.user_id,
  i.product_id,
  i.quantity,
  i.unit_price,
  i.subtotal,
  i.discount_amount,
  CAST(i.subtotal - i.discount_amount AS DECIMAL(12,2))      AS net_amount,
  i.create_time
FROM (
  SELECT *, PROCTIME() AS proc_time
  FROM ods.fact_order_item
) i
JOIN ods.fact_order
  /*+ OPTIONS('lookup.cache' = 'auto') */
  FOR SYSTEM_TIME AS OF i.proc_time AS o
  ON i.order_id  = o.order_id
 AND i.order_date = o.order_date
WHERE o.is_deleted = 0;

INSERT INTO dwd.fact_order_acc
SELECT
  order_id,
  order_date,
  user_id,
  order_status,
  order_time,
  pay_time,
  shipping_time,
  complete_time,
  cancel_time,
  CAST(TIMESTAMPDIFF(SECOND, order_time,    pay_time)      AS BIGINT) AS pay_duration_sec,
  CAST(TIMESTAMPDIFF(SECOND, pay_time,      shipping_time) AS BIGINT) AS ship_duration_sec,
  CAST(TIMESTAMPDIFF(SECOND, shipping_time, complete_time) AS BIGINT) AS receive_duration_sec,
  CAST(TIMESTAMPDIFF(SECOND, order_time,    complete_time) AS BIGINT) AS total_duration_sec,
  item_count,
  total_amount,
  discount_amount,
  CAST(CASE WHEN pay_time      IS NOT NULL THEN 1 ELSE 0 END AS TINYINT) AS is_paid,
  CAST(CASE WHEN shipping_time IS NOT NULL THEN 1 ELSE 0 END AS TINYINT) AS is_shipped,
  CAST(CASE WHEN complete_time IS NOT NULL THEN 1 ELSE 0 END AS TINYINT) AS is_completed,
  CAST(CASE WHEN cancel_time   IS NOT NULL THEN 1 ELSE 0 END AS TINYINT) AS is_cancelled,
  update_time
FROM ods.fact_order
WHERE is_deleted = 0;
