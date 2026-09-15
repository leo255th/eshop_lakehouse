SET 'execution.runtime-mode' = 'streaming';
SET 'table.exec.sink.upsert-materialize' = 'NONE';
SET 'execution.checkpointing.interval' = '10s';
SET 'state.backend' = 'rocksdb';
SET 'state.backend.incremental' = 'true';
SET 'execution.checkpointing.mode' = 'EXACTLY_ONCE';
SET 'state.checkpoints.dir' = 'hdfs:///flink/checkpoints';

SET 'table.local-time-zone' = 'Asia/Shanghai';

CREATE CATALOG paimon_eshop_1m WITH (
  'type'      = 'paimon',
  'warehouse' = 'hdfs:///paimon/warehouse/eshop_1m'
);

USE CATALOG paimon_eshop_1m;
CREATE DATABASE IF NOT EXISTS ods;
USE ods;

CREATE TEMPORARY TABLE cdc_dim_user (
  user_id          BIGINT,
  username         VARCHAR(64),
  phone            VARCHAR(20),
  email            VARCHAR(128),
  province         VARCHAR(32),
  city             VARCHAR(32),
  user_level       TINYINT,
  status           TINYINT,
  register_channel VARCHAR(32),
  first_order_time TIMESTAMP(3),
  is_deleted       TINYINT,
  deleted_time     TIMESTAMP(3),
  create_time      TIMESTAMP(3),
  update_time      TIMESTAMP(3),
  PRIMARY KEY (user_id) NOT ENFORCED
) WITH (
  'connector'                = 'mysql-cdc',
  'hostname'                 = 'hadoop103',
  'port'                     = '3307',
  'username'                 = 'root',
  'password'                 = '123456',
  'database-name'            = 'eshop_1m',
  'table-name'               = 'dim_user',
  'scan.startup.mode'        = 'initial',
  'scan.incremental.snapshot.enabled' = 'true',
  'server-id'                = '5400',
  'server-time-zone'         = 'Asia/Shanghai',
  'debezium.snapshot.mode'   = 'initial',
  'connect.timeout'          = '30s',
  'connect.max-retries'      = '5'
);

INSERT INTO dim_user
SELECT user_id, username, phone, email, province, city, user_level, status,
       register_channel, first_order_time, is_deleted, deleted_time,
       create_time, update_time
FROM cdc_dim_user;

CREATE TEMPORARY TABLE cdc_dim_product (
  product_id   BIGINT,
  product_name VARCHAR(128),
  category     VARCHAR(32),
  brand        VARCHAR(64),
  price        DECIMAL(10,2),
  cost_price   DECIMAL(10,2),
  stock        INT,
  status       TINYINT,
  is_deleted   TINYINT,
  deleted_time TIMESTAMP(3),
  create_time  TIMESTAMP(3),
  update_time  TIMESTAMP(3),
  PRIMARY KEY (product_id) NOT ENFORCED
) WITH (
  'connector'                = 'mysql-cdc',
  'hostname'                 = 'hadoop103',
  'port'                     = '3307',
  'username'                 = 'root',
  'password'                 = '123456',
  'database-name'            = 'eshop_1m',
  'table-name'               = 'dim_product',
  'scan.startup.mode'        = 'initial',
  'scan.incremental.snapshot.enabled' = 'true',
  'server-id'                = '5401',
  'server-time-zone'         = 'Asia/Shanghai',
  'debezium.snapshot.mode'   = 'initial',
  'connect.timeout'          = '30s',
  'connect.max-retries'      = '5'
);

INSERT INTO dim_product
SELECT product_id, product_name, category, brand, price, cost_price,
       stock, status, is_deleted, deleted_time, create_time, update_time
FROM cdc_dim_product;

CREATE TEMPORARY TABLE cdc_fact_order (
  order_id        BIGINT,
  user_id         BIGINT,
  order_status    VARCHAR(16),
  item_count      INT,
  total_amount    DECIMAL(12,2),
  discount_amount DECIMAL(12,2),
  pay_time        TIMESTAMP(3),
  shipping_time   TIMESTAMP(3),
  complete_time   TIMESTAMP(3),
  cancel_time     TIMESTAMP(3),
  order_time      TIMESTAMP(3),
  update_time     TIMESTAMP(3),
  is_deleted      TINYINT,
  deleted_time    TIMESTAMP(3),
  PRIMARY KEY (order_id) NOT ENFORCED
) WITH (
  'connector'                = 'mysql-cdc',
  'hostname'                 = 'hadoop103',
  'port'                     = '3307',
  'username'                 = 'root',
  'password'                 = '123456',
  'database-name'            = 'eshop_1m',
  'table-name'               = 'fact_order',
  'scan.startup.mode'        = 'initial',
  'scan.incremental.snapshot.enabled' = 'true',
  'server-id'                = '5402',
  'server-time-zone'         = 'Asia/Shanghai',
  'debezium.snapshot.mode'   = 'initial',
  'connect.timeout'          = '30s',
  'connect.max-retries'      = '5'
);

INSERT INTO fact_order
SELECT order_id,
       DATE_FORMAT(order_time, 'yyyyMMdd') AS order_date,
       user_id, order_status, item_count, total_amount, discount_amount,
       pay_time, shipping_time, complete_time, cancel_time,
       order_time, update_time, is_deleted, deleted_time
FROM cdc_fact_order;

CREATE TEMPORARY TABLE cdc_fact_order_item (
  item_id         BIGINT,
  order_id        BIGINT,
  product_id      BIGINT,
  quantity        INT,
  unit_price      DECIMAL(10,2),
  subtotal        DECIMAL(12,2),
  discount_amount DECIMAL(12,2),
  create_time     TIMESTAMP(3),
  PRIMARY KEY (item_id) NOT ENFORCED
) WITH (
  'connector'                = 'mysql-cdc',
  'hostname'                 = 'hadoop103',
  'port'                     = '3307',
  'username'                 = 'root',
  'password'                 = '123456',
  'database-name'            = 'eshop_1m',
  'table-name'               = 'fact_order_item',
  'scan.startup.mode'        = 'initial',
  'scan.incremental.snapshot.enabled' = 'true',
  'server-id'                = '5403',
  'server-time-zone'         = 'Asia/Shanghai',
  'debezium.snapshot.mode'   = 'initial',
  'connect.timeout'          = '30s',
  'connect.max-retries'      = '5'
);

INSERT INTO fact_order_item
SELECT item_id,
       DATE_FORMAT(create_time, 'yyyyMMdd') AS order_date,
       order_id, product_id, quantity, unit_price, subtotal, discount_amount, create_time
FROM cdc_fact_order_item;

CREATE TEMPORARY TABLE cdc_fact_product_price_change (
  change_id   BIGINT,
  product_id  BIGINT,
  old_price   DECIMAL(10,2),
  new_price   DECIMAL(10,2),
  change_type VARCHAR(16),
  change_time TIMESTAMP(3)
) WITH (
  'connector'                = 'mysql-cdc',
  'hostname'                 = 'hadoop103',
  'port'                     = '3307',
  'username'                 = 'root',
  'password'                 = '123456',
  'database-name'            = 'eshop_1m',
  'table-name'               = 'fact_product_price_change',
  'scan.startup.mode'        = 'initial',
  'scan.incremental.snapshot.enabled' = 'false',
  'server-id'                = '5404',
  'server-time-zone'         = 'Asia/Shanghai',
  'debezium.snapshot.mode'   = 'initial',
  'connect.timeout'          = '30s',
  'connect.max-retries'      = '5'
);

INSERT INTO fact_product_price_change
SELECT change_id,
       DATE_FORMAT(change_time, 'yyyyMMdd') AS change_date,
       product_id, old_price, new_price, change_type, change_time
FROM cdc_fact_product_price_change;

CREATE TEMPORARY TABLE cdc_fact_stock_change (
  change_id   BIGINT,
  product_id  BIGINT,
  order_id    BIGINT,
  change_type VARCHAR(16),
  delta       INT,
  stock_after INT,
  change_time TIMESTAMP(3)
) WITH (
  'connector'                = 'mysql-cdc',
  'hostname'                 = 'hadoop103',
  'port'                     = '3307',
  'username'                 = 'root',
  'password'                 = '123456',
  'database-name'            = 'eshop_1m',
  'table-name'               = 'fact_stock_change',
  'scan.startup.mode'        = 'initial',
  'scan.incremental.snapshot.enabled' = 'false',
  'server-id'                = '5405',
  'server-time-zone'         = 'Asia/Shanghai',
  'debezium.snapshot.mode'   = 'initial',
  'connect.timeout'          = '30s',
  'connect.max-retries'      = '5'
);

INSERT INTO fact_stock_change
SELECT change_id,
       DATE_FORMAT(change_time, 'yyyyMMdd') AS change_date,
       product_id, order_id, change_type, delta, stock_after, change_time
FROM cdc_fact_stock_change;
