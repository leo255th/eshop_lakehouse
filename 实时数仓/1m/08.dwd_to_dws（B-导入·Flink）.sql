SET 'execution.runtime-mode' = 'streaming';
SET 'execution.checkpointing.interval' = '10s';
SET 'state.backend' = 'rocksdb';
SET 'state.backend.incremental' = 'true';
SET 'table.exec.sink.upsert-materialize' = 'NONE';
SET 'table.local-time-zone' = 'Asia/Shanghai';

CREATE CATALOG paimon_eshop_1m WITH (
  'type'      = 'paimon',
  'warehouse' = 'hdfs:///paimon/warehouse/eshop_1m'
);
USE CATALOG paimon_eshop_1m;
USE dwd;

CREATE TEMPORARY TABLE doris_dim_product (
  product_id   BIGINT,
  product_name VARCHAR(128),
  category     VARCHAR(32),
  brand        VARCHAR(64),
  price        DECIMAL(10,2),
  price_band   VARCHAR(16),
  cost_price   DECIMAL(10,2),
  gross_margin DECIMAL(5,4),
  stock        INT,
  status       TINYINT,
  create_time  TIMESTAMP(3),
  update_time  TIMESTAMP(3),
  PRIMARY KEY (product_id) NOT ENFORCED
) WITH (
  'connector'              = 'doris',
  'fenodes'                = 'hadoop101:8030',
  'table.identifier'       = 'dwd_eshop_1m.dim_product',
  'username'               = 'root',
  'password'               = 'doris@1998',
  'sink.label-prefix'      = 'eshop_1m_doris_dim_product',
  'sink.properties.format' = 'json',
  'sink.properties.read_json_by_line' = 'true',
  'sink.enable-delete'     = 'true',
  'sink.parallelism'       = '1'
);

INSERT INTO doris_dim_product
SELECT product_id, product_name, category, brand, price, price_band, cost_price,
       gross_margin, stock, status, create_time, update_time
FROM dwd.dim_product;

CREATE TEMPORARY TABLE doris_dim_user (
  user_id          BIGINT,
  username         VARCHAR(64),
  province         VARCHAR(32),
  city             VARCHAR(32),
  user_level       TINYINT,
  user_level_name  VARCHAR(8),
  status           TINYINT,
  register_channel VARCHAR(32),
  is_new_user      TINYINT,
  first_order_time TIMESTAMP(3),
  create_time      TIMESTAMP(3),
  update_time      TIMESTAMP(3),
  PRIMARY KEY (user_id) NOT ENFORCED
) WITH (
  'connector'              = 'doris',
  'fenodes'                = 'hadoop101:8030',
  'table.identifier'       = 'dwd_eshop_1m.dim_user',
  'username'               = 'root',
  'password'               = 'doris@1998',
  'sink.label-prefix'      = 'eshop_1m_doris_dim_user',
  'sink.properties.format' = 'json',
  'sink.properties.read_json_by_line' = 'true',
  'sink.enable-delete'     = 'true',
  'sink.parallelism'       = '1'
);

INSERT INTO doris_dim_user
SELECT user_id, username, province, city, user_level, user_level_name, status,
       register_channel, is_new_user, first_order_time, create_time, update_time
FROM dwd.dim_user;

CREATE TEMPORARY TABLE doris_fact_order_item (
  dt              DATE,
  item_id         BIGINT,
  product_id      BIGINT,
  order_id        BIGINT,
  user_id         BIGINT,
  quantity        INT,
  unit_price      DECIMAL(10,2),
  subtotal        DECIMAL(12,2),
  discount_amount DECIMAL(12,2),
  net_amount      DECIMAL(12,2),
  create_time     TIMESTAMP(3),
  PRIMARY KEY (dt, item_id, product_id) NOT ENFORCED
) WITH (
  'connector'              = 'doris',
  'fenodes'                = 'hadoop101:8030',
  'table.identifier'       = 'dwd_eshop_1m.fact_order_item',
  'username'               = 'root',
  'password'               = 'doris@1998',
  'sink.label-prefix'      = 'eshop_1m_doris_fact_order_item',
  'sink.properties.format' = 'json',
  'sink.properties.read_json_by_line' = 'true',
  'sink.enable-delete'     = 'true',
  'sink.parallelism'       = '2'
);

INSERT INTO doris_fact_order_item
SELECT TO_DATE(order_date, 'yyyyMMdd') AS dt,
       item_id, product_id, order_id, user_id, quantity, unit_price,
       subtotal, discount_amount, net_amount, create_time
FROM dwd.fact_order_item;

CREATE TEMPORARY TABLE doris_fact_order_acc (
  dt                   DATE,
  order_id             BIGINT,
  user_id              BIGINT,
  order_status         VARCHAR(16),
  order_time           TIMESTAMP(3),
  pay_time             TIMESTAMP(3),
  shipping_time        TIMESTAMP(3),
  complete_time        TIMESTAMP(3),
  cancel_time          TIMESTAMP(3),
  pay_duration_sec     BIGINT,
  ship_duration_sec    BIGINT,
  receive_duration_sec BIGINT,
  total_duration_sec   BIGINT,
  item_count           INT,
  total_amount         DECIMAL(12,2),
  discount_amount      DECIMAL(12,2),
  is_paid              TINYINT,
  is_shipped           TINYINT,
  is_completed         TINYINT,
  is_cancelled         TINYINT,
  update_time          TIMESTAMP(3),
  PRIMARY KEY (dt, order_id, user_id) NOT ENFORCED
) WITH (
  'connector'              = 'doris',
  'fenodes'                = 'hadoop101:8030',
  'table.identifier'       = 'dwd_eshop_1m.fact_order_acc',
  'username'               = 'root',
  'password'               = 'doris@1998',
  'sink.label-prefix'      = 'eshop_1m_doris_fact_order_acc',
  'sink.properties.format' = 'json',
  'sink.properties.read_json_by_line' = 'true',
  'sink.enable-delete'     = 'true',
  'sink.parallelism'       = '2'
);

INSERT INTO doris_fact_order_acc
SELECT TO_DATE(order_date, 'yyyyMMdd') AS dt,
       order_id, user_id, order_status, order_time, pay_time, shipping_time,
       complete_time, cancel_time, pay_duration_sec, ship_duration_sec,
       receive_duration_sec, total_duration_sec, item_count, total_amount,
       discount_amount, is_paid, is_shipped, is_completed, is_cancelled, update_time
FROM dwd.fact_order_acc;

CREATE TEMPORARY TABLE doris_dws_trade_user_day (
  dt                   DATE,
  user_id              BIGINT,
  order_cnt            BIGINT,
  item_qty             BIGINT,
  order_amount         DECIMAL(18,2),
  pay_cnt              BIGINT,
  pay_amount           DECIMAL(18,2),
  shipped_cnt          BIGINT,
  shipped_amount       DECIMAL(18,2),
  complete_cnt         BIGINT,
  complete_amount      DECIMAL(18,2),
  cancel_cnt           BIGINT,
  cancel_amount        DECIMAL(18,2),
  discount_amount      DECIMAL(18,2),
  pay_duration_sum     BIGINT,
  ship_duration_sum    BIGINT,
  receive_duration_sum BIGINT,
  first_order_time     TIMESTAMP(3),
  last_order_time      TIMESTAMP(3),
  etl_time             TIMESTAMP(3),
  PRIMARY KEY (dt, user_id) NOT ENFORCED
) WITH (
  'connector'              = 'doris',
  'fenodes'                = 'hadoop101:8030',
  'table.identifier'       = 'dws_eshop_1m.dws_trade_user_day',
  'username'               = 'root',
  'password'               = 'doris@1998',
  'sink.label-prefix'      = 'eshop_1m_doris_dws_trade_user_day',
  'sink.properties.format' = 'json',
  'sink.properties.read_json_by_line' = 'true',
  'sink.enable-delete'     = 'true',
  'sink.parallelism'       = '2'
);

INSERT INTO doris_dws_trade_user_day
SELECT
  TO_DATE(order_date, 'yyyyMMdd')                                             AS dt,
  user_id,
  COUNT(*)                                                                    AS order_cnt,
  SUM(item_count)                                                             AS item_qty,
  CAST(SUM(total_amount) AS DECIMAL(18,2))                                    AS order_amount,
  SUM(CASE WHEN is_paid = 1 THEN 1 ELSE 0 END)                                AS pay_cnt,
  CAST(SUM(CASE WHEN is_paid = 1 THEN total_amount ELSE 0 END) AS DECIMAL(18,2))      AS pay_amount,
  SUM(CASE WHEN is_shipped = 1 THEN 1 ELSE 0 END)                             AS shipped_cnt,
  CAST(SUM(CASE WHEN is_shipped = 1 THEN total_amount ELSE 0 END) AS DECIMAL(18,2))   AS shipped_amount,
  SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END)                           AS complete_cnt,
  CAST(SUM(CASE WHEN is_completed = 1 THEN total_amount ELSE 0 END) AS DECIMAL(18,2)) AS complete_amount,
  SUM(CASE WHEN is_cancelled = 1 THEN 1 ELSE 0 END)                           AS cancel_cnt,
  CAST(SUM(CASE WHEN is_cancelled = 1 THEN total_amount ELSE 0 END) AS DECIMAL(18,2)) AS cancel_amount,
  CAST(SUM(discount_amount) AS DECIMAL(18,2))                                 AS discount_amount,
  SUM(pay_duration_sec)                                                       AS pay_duration_sum,
  SUM(ship_duration_sec)                                                      AS ship_duration_sum,
  SUM(receive_duration_sec)                                                   AS receive_duration_sum,
  MIN(order_time)                                                             AS first_order_time,
  MAX(order_time)                                                             AS last_order_time,
  CURRENT_TIMESTAMP                                                           AS etl_time
FROM dwd.fact_order_acc
GROUP BY TO_DATE(order_date, 'yyyyMMdd'), user_id;

--     SELECT COUNT(*) FROM dwd_eshop_1m.fact_order_item;
--     SELECT COUNT(*) FROM dwd_eshop_1m.fact_order_acc;
