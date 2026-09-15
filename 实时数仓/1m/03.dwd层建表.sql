SET 'table.local-time-zone' = 'Asia/Shanghai';

CREATE CATALOG paimon_eshop_1m WITH (
  'type'      = 'paimon',
  'warehouse' = 'hdfs:///paimon/warehouse/eshop_1m'
);

USE CATALOG paimon_eshop_1m;

CREATE DATABASE IF NOT EXISTS dwd;

USE dwd;

DROP TABLE IF EXISTS dim_date;
CREATE TABLE dim_date (
  dt            DATE        COMMENT '日期（主键）',
  dt_year       INT         COMMENT '年',
  dt_quarter    INT         COMMENT '季度 1-4',
  dt_month      INT         COMMENT '月 1-12',
  dt_day        INT         COMMENT '日 1-31',
  week_of_year  INT         COMMENT '年内第几周（含 week 但是复合词，无歧义）',
  day_of_week   INT         COMMENT '星期几 1=周一 ... 7=周日',
  is_weekend    TINYINT     COMMENT '1周末 0工作日',
  year_month    VARCHAR(7)  COMMENT 'yyyy-MM（复合词，无歧义）',
  year_week     VARCHAR(8)  COMMENT 'yyyy-WW（复合词，无歧义）',
  date_str      VARCHAR(8)  COMMENT 'yyyyMMdd（与 ODS 分区键格式对齐，便于 join）',
  PRIMARY KEY (dt) NOT ENFORCED
) WITH (
  'bucket'              = '1',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro'
);

DROP TABLE IF EXISTS dim_user;
CREATE TABLE dim_user (
  user_id          BIGINT       COMMENT '用户id',
  username         VARCHAR(64)  COMMENT '用户名',
  phone            VARCHAR(20)  COMMENT '手机号',
  email            VARCHAR(128) COMMENT '邮箱',
  province         VARCHAR(32)  COMMENT '省份（用户所在地，非收货地）',
  city             VARCHAR(32)  COMMENT '城市（用户所在地）',
  user_level       TINYINT      COMMENT '1普通 2银牌 3金牌',
  user_level_name  VARCHAR(8)   COMMENT '等级名称（派生，便于 BI 直接展示）',
  status           TINYINT      COMMENT '1正常 0已注销',
  register_channel VARCHAR(32)  COMMENT '注册渠道',
  is_new_user      TINYINT      COMMENT '是否下过单 1是 0否（由 first_order_time 派生）',
  first_order_time TIMESTAMP(3) COMMENT '首次下单时间',
  create_time      TIMESTAMP(3) COMMENT '注册时间',
  update_time      TIMESTAMP(3) COMMENT '最近变更时间',
  PRIMARY KEY (user_id) NOT ENFORCED
) WITH (
  'bucket'              = '1',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro'
);

DROP TABLE IF EXISTS dim_product;
CREATE TABLE dim_product (
  product_id   BIGINT        COMMENT '商品id',
  product_name VARCHAR(128)  COMMENT '商品名',
  category     VARCHAR(32)   COMMENT '品类',
  brand        VARCHAR(64)   COMMENT '品牌',
  price        DECIMAL(10,2) COMMENT '当前售价（注意：算历史 GMV 必须用 fact 里的快照价，不能用这个）',
  price_band   VARCHAR(16)   COMMENT '价格带（派生）：低价/中价/高价/超高价',
  cost_price   DECIMAL(10,2) COMMENT '成本价（毛利分析用）',
  gross_margin DECIMAL(5,4)  COMMENT '毛利率 = (price-cost_price)/price（派生）',
  stock        INT           COMMENT '当前库存',
  status       TINYINT       COMMENT '1上架 0下架',
  create_time  TIMESTAMP(3)  COMMENT '创建时间',
  update_time  TIMESTAMP(3)  COMMENT '最近变更时间',
  PRIMARY KEY (product_id) NOT ENFORCED
) WITH (
  'bucket'              = '1',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro'
);

DROP TABLE IF EXISTS dim_product_price_scd2;
CREATE TABLE dim_product_price_scd2 (
  product_id       BIGINT        COMMENT '商品id（自然键）',
  dt               VARCHAR(8)    COMMENT '分区：版本起始日期 yyyyMMdd（由 price_start_time 生成）',
  price            DECIMAL(10,2) COMMENT '该版本有效期的售价',
  price_start_time TIMESTAMP(3)  COMMENT '该版本生效开始时间',
  price_end_time   TIMESTAMP(3)  COMMENT '该版本生效结束时间（当前版本为 9999-12-31）',
  is_current       TINYINT       COMMENT '1=当前版本 0=历史版本',
  version_no       INT           COMMENT '版本序号（从 1 开始，便于排查）',
  change_type      VARCHAR(16)   COMMENT '该版本的来源事件类型 INIT/ADJUST/OFFSHELF',
  event_seq        BIGINT        COMMENT '技术列：触发本行写入的变更事件序号（越大越新）',
  PRIMARY KEY (dt, product_id, price_start_time) NOT ENFORCED
) PARTITIONED BY (dt)
WITH (
  'bucket'              = '1',
  'bucket-key'          = 'product_id',
  'merge-engine'        = 'deduplicate',
  'sequence.field'      = 'event_seq',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro'
);

DROP TABLE IF EXISTS fact_order_item;
CREATE TABLE fact_order_item (
  item_id         BIGINT        COMMENT '明细id',
  order_date      VARCHAR(8)    COMMENT '分区：下单日期 yyyyMMdd',
  order_id        BIGINT        COMMENT '订单id（退化维度，用于订单级去重）',
  user_id         BIGINT        COMMENT '用户id（从订单带下来，避免每次 join）',
  product_id      BIGINT        COMMENT '商品id',
  quantity        INT           COMMENT '数量',
  unit_price      DECIMAL(10,2) COMMENT '下单瞬间价格快照（事实快照，业务正确）',
  subtotal        DECIMAL(12,2) COMMENT 'quantity * unit_price（优惠前）',
  discount_amount DECIMAL(12,2) COMMENT '明细优惠金额',
  net_amount      DECIMAL(12,2) COMMENT '实付金额 = subtotal - discount_amount',
  create_time     TIMESTAMP(3)  COMMENT '下单时间（事件时间）',
  PRIMARY KEY (order_date, item_id) NOT ENFORCED
) PARTITIONED BY (order_date)
WITH (
  'bucket'              = '2',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro'
);

DROP TABLE IF EXISTS fact_order_acc;
CREATE TABLE fact_order_acc (
  order_id             BIGINT        COMMENT '订单id',
  order_date           VARCHAR(8)    COMMENT '分区：下单日期 yyyyMMdd',
  user_id              BIGINT        COMMENT '用户id',
  order_status         VARCHAR(16)   COMMENT '当前状态',
  order_time           TIMESTAMP(3)  COMMENT '里程碑0：下单时间',
  pay_time             TIMESTAMP(3)  COMMENT '里程碑1：支付时间',
  shipping_time        TIMESTAMP(3)  COMMENT '里程碑2：发货时间',
  complete_time        TIMESTAMP(3)  COMMENT '里程碑3：完成时间',
  cancel_time          TIMESTAMP(3)  COMMENT '终止：取消时间',
  pay_duration_sec     BIGINT        COMMENT '下单→支付耗时',
  ship_duration_sec    BIGINT        COMMENT '支付→发货耗时',
  receive_duration_sec BIGINT        COMMENT '发货→完成耗时',
  total_duration_sec   BIGINT        COMMENT '下单→完成总耗时',
  item_count           INT           COMMENT '商品总件数',
  total_amount         DECIMAL(12,2) COMMENT '订单实付金额',
  discount_amount      DECIMAL(12,2) COMMENT '订单优惠总额',
  is_paid              TINYINT       COMMENT '是否已支付 1/0',
  is_shipped           TINYINT       COMMENT '是否已发货 1/0',
  is_completed         TINYINT       COMMENT '是否已完成 1/0',
  is_cancelled         TINYINT       COMMENT '是否已取消 1/0',
  update_time          TIMESTAMP(3)  COMMENT '最近变更时间',
  PRIMARY KEY (order_date, order_id) NOT ENFORCED
) PARTITIONED BY (order_date)
WITH (
  'bucket'              = '2',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro'
);

DROP TABLE IF EXISTS fact_product_stock_per_day;
CREATE TABLE fact_product_stock_per_day (
  dt                DATE        COMMENT '统计日期',
  dt_str            VARCHAR(8)  COMMENT '分区：yyyyMMdd（与 ODS 分区键格式对齐）',
  product_id        BIGINT      COMMENT '商品id',
  day_open_stock    INT         COMMENT '当日开盘库存',
  day_end_stock     INT         COMMENT '当日期末库存（★ 半可加：跨时间不可加）',
  day_deduct_qty    INT         COMMENT '当日扣减量（负数）',
  day_replenish_qty INT         COMMENT '当日补货量（正数）',
  day_net_change    INT         COMMENT '当日净变动',
  change_cnt        INT         COMMENT '当日变更次数',
  PRIMARY KEY (dt_str, product_id) NOT ENFORCED
) PARTITIONED BY (dt_str)
WITH (
  'bucket'              = '1',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro'
);

SHOW TABLES;
