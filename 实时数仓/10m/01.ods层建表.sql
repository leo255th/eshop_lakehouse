SET 'table.local-time-zone' = 'Asia/Shanghai';

CREATE CATALOG paimon_eshop_10m WITH (
  'type'      = 'paimon',
  'warehouse' = 'hdfs:///paimon/warehouse/eshop_10m'
);

USE CATALOG paimon_eshop_10m;

CREATE DATABASE IF NOT EXISTS ods;

USE ods;

DROP TABLE IF EXISTS dim_user;
CREATE TABLE dim_user (
  user_id          BIGINT       COMMENT '用户id',
  username         VARCHAR(64)  COMMENT '用户名',
  phone            VARCHAR(20)  COMMENT '手机号',
  email            VARCHAR(128) COMMENT '邮箱',
  province         VARCHAR(32)  COMMENT '省份（用户所在地，非收货地）',
  city             VARCHAR(32)  COMMENT '城市（用户所在地）',
  user_level       TINYINT      COMMENT '1普通 2银牌 3金牌',
  status           TINYINT      COMMENT '1正常 0已注销',
  register_channel VARCHAR(32)  COMMENT '注册渠道 App/小程序/H5/线下门店/广告投放',
  first_order_time TIMESTAMP(3) COMMENT '首次下单时间（新客判定用）',
  is_deleted       TINYINT      COMMENT '1已逻辑删除',
  deleted_time     TIMESTAMP(3) COMMENT '删除时间',
  create_time      TIMESTAMP(3) COMMENT '注册时间',
  update_time      TIMESTAMP(3) COMMENT '最近变更时间',
  PRIMARY KEY (user_id) NOT ENFORCED
) WITH (
  'bucket'              = '1',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro',
  'sink.parallelism'    = '1'
);

DROP TABLE IF EXISTS dim_product;
CREATE TABLE dim_product (
  product_id   BIGINT        COMMENT '商品id',
  product_name VARCHAR(128)  COMMENT '商品名',
  category     VARCHAR(32)   COMMENT '品类（8 大品类）',
  brand        VARCHAR(64)   COMMENT '品牌',
  price        DECIMAL(10,2) COMMENT '当前售价（会变化）',
  cost_price   DECIMAL(10,2) COMMENT '成本价',
  stock        INT           COMMENT '当前库存',
  status       TINYINT       COMMENT '1上架 0下架',
  is_deleted   TINYINT       COMMENT '1已逻辑删除',
  deleted_time TIMESTAMP(3)  COMMENT '删除时间',
  create_time  TIMESTAMP(3)  COMMENT '创建时间',
  update_time  TIMESTAMP(3)  COMMENT '最近变更时间',
  PRIMARY KEY (product_id) NOT ENFORCED
) WITH (
  'bucket'              = '1',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro',
  'sink.parallelism'    = '1'
);

DROP TABLE IF EXISTS fact_order;
CREATE TABLE fact_order (
  order_id        BIGINT        COMMENT '订单id',
  order_date      VARCHAR(8)    COMMENT '分区：下单日期 yyyyMMdd（由 order_time 生成，不可变）',
  user_id         BIGINT        COMMENT '用户id',
  order_status    VARCHAR(16)   COMMENT 'CREATED/PAID/SHIPPED/COMPLETED/CANCELLED',
  item_count      INT           COMMENT '商品总件数',
  total_amount    DECIMAL(12,2) COMMENT '订单总金额',
  discount_amount DECIMAL(12,2) COMMENT '订单优惠总额',
  pay_time        TIMESTAMP(3)  COMMENT '支付时间（里程碑1）',
  shipping_time   TIMESTAMP(3)  COMMENT '发货时间（里程碑2）',
  complete_time   TIMESTAMP(3)  COMMENT '完成时间（里程碑3）',
  cancel_time     TIMESTAMP(3)  COMMENT '取消时间（终止）',
  order_time      TIMESTAMP(3)  COMMENT '下单时间=事件时间，落库后不变',
  update_time     TIMESTAMP(3)  COMMENT '最近变更时间',
  is_deleted      TINYINT       COMMENT '1已逻辑删除',
  deleted_time    TIMESTAMP(3)  COMMENT '删除时间',
  PRIMARY KEY (order_date, order_id) NOT ENFORCED
) PARTITIONED BY (order_date)
WITH (
  'bucket'              = '2',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro',
  'sink.parallelism'    = '2'
);

DROP TABLE IF EXISTS fact_order_item;
CREATE TABLE fact_order_item (
  item_id         BIGINT        COMMENT '明细id',
  order_date      VARCHAR(8)    COMMENT '分区：下单日期 yyyyMMdd（由 create_time 生成，不可变）',
  order_id        BIGINT        COMMENT '订单id',
  product_id      BIGINT        COMMENT '商品id',
  quantity        INT           COMMENT '数量',
  unit_price      DECIMAL(10,2) COMMENT '下单瞬间价格快照（之后不变）',
  subtotal        DECIMAL(12,2) COMMENT 'quantity * unit_price（优惠前）',
  discount_amount DECIMAL(12,2) COMMENT '明细优惠金额',
  create_time     TIMESTAMP(3)  COMMENT '下单时间（与 order_time 同值）',
  PRIMARY KEY (order_date, item_id) NOT ENFORCED
) PARTITIONED BY (order_date)
WITH (
  'bucket'              = '2',
  'merge-engine'        = 'deduplicate',
  'changelog-producer'  = 'input',
  'file.format'         = 'avro',
  'sink.parallelism'    = '2'
);

DROP TABLE IF EXISTS fact_product_price_change;
CREATE TABLE fact_product_price_change (
  change_id   BIGINT        COMMENT '变更流水id',
  change_date VARCHAR(8)    COMMENT '分区：变更日期 yyyyMMdd（由 change_time 生成，不可变）',
  product_id  BIGINT        COMMENT '商品id',
  old_price   DECIMAL(10,2) COMMENT '变更前价格（INIT 时为 NULL）',
  new_price   DECIMAL(10,2) COMMENT '变更后价格',
  change_type VARCHAR(16)   COMMENT 'INIT/ADJUST/OFFSHELF/FINAL',
  change_time TIMESTAMP(3)  COMMENT '变更时间'
) PARTITIONED BY (change_date)
WITH (
  'bucket'           = '1',
  'bucket-key'       = 'change_id',
  'scan.plan-sort-partition' = 'true',
  'file.format'      = 'avro',
  'sink.parallelism' = '1'
);

DROP TABLE IF EXISTS fact_stock_change;
CREATE TABLE fact_stock_change (
  change_id   BIGINT       COMMENT '变更流水id',
  change_date VARCHAR(8)   COMMENT '分区：变更日期 yyyyMMdd（由 change_time 生成，不可变）',
  product_id  BIGINT       COMMENT '商品id',
  order_id    BIGINT       COMMENT '关联订单id（下单扣减时有值）',
  change_type VARCHAR(16)  COMMENT 'INIT/ORDER_DEDUCT/REPLENISH/ADJUST',
  delta       INT          COMMENT '变动量（负数为扣减）',
  stock_after INT          COMMENT '变动后库存',
  change_time TIMESTAMP(3) COMMENT '变更时间'
) PARTITIONED BY (change_date)
WITH (
  'bucket'           = '1',
  'bucket-key'       = 'change_id',
  'scan.plan-sort-partition' = 'true',
  'file.format'      = 'avro',
  'sink.parallelism' = '1'
);

SHOW TABLES;

SHOW CREATE TABLE dim_product;
