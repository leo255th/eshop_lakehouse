-- CREATE USER IF NOT EXISTS 'etl'@'%' IDENTIFIED BY 'Etl@2026';
-- GRANT ALL         ON dwd_eshop_10m.* TO 'etl'@'%';
-- GRANT ALL         ON dws_eshop_10m.* TO 'etl'@'%';
-- GRANT ALL         ON ads_eshop_10m.* TO 'etl'@'%';
-- GRANT SELECT_PRIV ON paimon_eshop_10m.*.* TO 'etl'@'%';

ADMIN SET FRONTEND CONFIG ("dynamic_partition_check_interval_seconds" = "5");

CREATE DATABASE IF NOT EXISTS dwd_eshop_10m;
USE dwd_eshop_10m;

DROP TABLE IF EXISTS dim_product;
CREATE TABLE dim_product (
  product_id   BIGINT       NOT NULL COMMENT '商品id',
  product_name VARCHAR(384)          COMMENT '商品名',
  category     VARCHAR(96)           COMMENT '品类',
  brand        VARCHAR(192)           COMMENT '品牌',
  price        DECIMAL(10,2)         COMMENT '当前售价（会变化 → 实验 4 的"错误口径"来源）',
  price_band   VARCHAR(64)           COMMENT '价格带（DWD 派生）',
  cost_price   DECIMAL(10,2)         COMMENT '成本价',
  gross_margin DECIMAL(5,4)          COMMENT '毛利率（DWD 派生）',
  stock        INT                   COMMENT '当前库存',
  status       TINYINT               COMMENT '1上架 0下架',
  create_time  DATETIME              COMMENT '创建时间',
  update_time  DATETIME              COMMENT '最近变更时间'
) UNIQUE KEY(product_id)
DISTRIBUTED BY HASH(product_id) BUCKETS 8
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "bloom_filter_columns" = "category,brand",
  "colocate_with" = "grp_eshop_10m_product"
);

DROP TABLE IF EXISTS dim_user;
CREATE TABLE dim_user (
  user_id          BIGINT       NOT NULL COMMENT '用户id',
  username         VARCHAR(192)           COMMENT '用户名',
  province         VARCHAR(96)           COMMENT '省份（地域域汇总用）',
  city             VARCHAR(96)           COMMENT '城市',
  user_level       TINYINT               COMMENT '1普通 2银牌 3金牌',
  user_level_name  VARCHAR(32)            COMMENT '等级名称（DWD 派生）',
  status           TINYINT               COMMENT '1正常 0注销',
  register_channel VARCHAR(96)           COMMENT '注册渠道',
  is_new_user      TINYINT               COMMENT '1新客 0老客（DWD 派生）',
  first_order_time DATETIME              COMMENT '首次下单时间',
  create_time      DATETIME              COMMENT '注册时间',
  update_time      DATETIME              COMMENT '最近变更时间'
) UNIQUE KEY(user_id)
DISTRIBUTED BY HASH(user_id) BUCKETS 4
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "bloom_filter_columns" = "province,register_channel"
);

DROP TABLE IF EXISTS dim_date;
CREATE TABLE dim_date (
  dt           DATE         NOT NULL COMMENT '日期（主键）',
  dt_year      INT                   COMMENT '年',
  dt_quarter   INT                   COMMENT '季度',
  dt_month     INT                   COMMENT '月',
  dt_day       INT                   COMMENT '日',
  week_of_year INT                   COMMENT '年内第几周',
  day_of_week  INT                   COMMENT '1=周一 … 7=周日',
  is_weekend   TINYINT               COMMENT '1=周末',
  year_month   VARCHAR(7)            COMMENT 'yyyy-MM',
  year_week    VARCHAR(10)           COMMENT 'yyyy-Www',
  date_str     VARCHAR(8)            COMMENT 'yyyyMMdd'
) UNIQUE KEY(dt)
DISTRIBUTED BY HASH(dt) BUCKETS 1
PROPERTIES ("replication_num" = "1", "compression" = "ZSTD");

DROP TABLE IF EXISTS fact_order_item;
CREATE TABLE fact_order_item (
  dt              DATE         NOT NULL COMMENT '分区：下单日期',
  item_id         BIGINT       NOT NULL COMMENT '明细id',
  product_id      BIGINT       NOT NULL COMMENT '商品id',
  order_id        BIGINT                COMMENT '订单id（退化维度）',
  user_id         BIGINT                COMMENT '用户id（DWD 层冗余下来）',
  quantity        INT                   COMMENT '数量',
  unit_price      DECIMAL(10,2)         COMMENT '下单瞬间价格快照（业务正确的 GMV 基准）',
  subtotal        DECIMAL(12,2)         COMMENT 'quantity * unit_price（优惠前）',
  discount_amount DECIMAL(12,2)         COMMENT '明细优惠',
  net_amount      DECIMAL(12,2)         COMMENT '实付金额 = subtotal - discount_amount',
  create_time     DATETIME              COMMENT '下单时间'
) UNIQUE KEY(dt, item_id, product_id)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(product_id) BUCKETS 8
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "8",
  "dynamic_partition.create_history_partition" = "true",
  "bloom_filter_columns" = "order_id,user_id,product_id",
  "colocate_with" = "grp_eshop_10m_product"
);

DROP TABLE IF EXISTS fact_order_acc;
CREATE TABLE fact_order_acc (
  dt                  DATE         NOT NULL COMMENT '分区：下单日期',
  order_id            BIGINT       NOT NULL COMMENT '订单id',
  user_id             BIGINT       NOT NULL COMMENT '用户id',
  order_status        VARCHAR(48)           COMMENT 'CREATED/PAID/SHIPPED/COMPLETED/CANCELLED',
  order_time          DATETIME              COMMENT '下单时间（★ 时间口径用它，不用 update_time）',
  pay_time            DATETIME              COMMENT '支付时间',
  shipping_time       DATETIME              COMMENT '发货时间',
  complete_time       DATETIME              COMMENT '完成时间',
  cancel_time         DATETIME              COMMENT '取消时间',
  pay_duration_sec    BIGINT                COMMENT '下单→支付 秒',
  ship_duration_sec   BIGINT                COMMENT '支付→发货 秒',
  receive_duration_sec BIGINT               COMMENT '发货→完成 秒',
  total_duration_sec  BIGINT                COMMENT '下单→完成 秒',
  item_count          INT                   COMMENT '件数',
  total_amount        DECIMAL(12,2)         COMMENT '订单金额（净额，已扣优惠）',
  discount_amount     DECIMAL(12,2)         COMMENT '订单优惠总额',
  is_paid             TINYINT               COMMENT '漏斗标记',
  is_shipped          TINYINT               COMMENT '漏斗标记',
  is_completed        TINYINT               COMMENT '漏斗标记',
  is_cancelled        TINYINT               COMMENT '漏斗标记',
  update_time         DATETIME              COMMENT '最近变更时间'
) UNIQUE KEY(dt, order_id, user_id)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(user_id) BUCKETS 8
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "8",
  "dynamic_partition.create_history_partition" = "true",
  "bloom_filter_columns" = "user_id,order_status"
);

DROP TABLE IF EXISTS dim_product_price_scd2;
CREATE TABLE dim_product_price_scd2 (
  dt               DATE         NOT NULL COMMENT '分区：版本起始日期',
  product_id       BIGINT       NOT NULL COMMENT '商品id（自然键）',
  price_start_time DATETIME(3)  NOT NULL COMMENT '版本生效开始（★ 联合主键一部分）',
  price            DECIMAL(10,2)         COMMENT '该版本售价',
  price_end_time   DATETIME(3)           COMMENT '版本生效结束（当前版本 9999-12-31）',
  is_current       TINYINT               COMMENT '1=当前版本',
  version_no       INT                   COMMENT '版本序号',
  change_type      VARCHAR(48)           COMMENT 'INIT/ADJUST/OFFSHELF',
  event_seq        BIGINT                COMMENT '写入序号（Paimon sequence.field 用）'
) UNIQUE KEY(dt, product_id, price_start_time)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(product_id) BUCKETS 8
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "8",
  "dynamic_partition.create_history_partition" = "true",
  "bloom_filter_columns" = "product_id"
);

CREATE DATABASE IF NOT EXISTS dws_eshop_10m;
USE dws_eshop_10m;

DROP TABLE IF EXISTS dws_trade_user_day;
CREATE TABLE dws_trade_user_day (
  dt              DATE         NOT NULL COMMENT '统计日期',
  user_id         BIGINT       NOT NULL COMMENT '用户id',
  order_cnt       BIGINT                COMMENT '下单订单数（COUNT）',
  item_qty        BIGINT                COMMENT '下单件数（SUM，可加）',
  order_amount    DECIMAL(18,2)         COMMENT '下单GMV（净额，= SUM(total_amount)）',
  pay_cnt         BIGINT                COMMENT '支付订单数',
  pay_amount      DECIMAL(18,2)         COMMENT '支付GMV',
  shipped_cnt     BIGINT                COMMENT '发货订单数（漏斗第3层）',
  shipped_amount  DECIMAL(18,2)         COMMENT '发货金额',
  complete_cnt    BIGINT                COMMENT '完成订单数',
  complete_amount DECIMAL(18,2)         COMMENT '完成GMV',
  cancel_cnt      BIGINT                COMMENT '取消订单数',
  cancel_amount   DECIMAL(18,2)         COMMENT '取消金额',
  discount_amount DECIMAL(18,2)         COMMENT '优惠总额（分母用）',
  pay_duration_sum     BIGINT           COMMENT '下单→支付 秒之和',
  ship_duration_sum    BIGINT           COMMENT '支付→发货 秒之和',
  receive_duration_sum BIGINT           COMMENT '发货→完成 秒之和',
  first_order_time DATETIME             COMMENT '当日首单时间',
  last_order_time  DATETIME             COMMENT '当日末单时间',
  etl_time        DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(dt, user_id)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(user_id) BUCKETS 8
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "8",
  "dynamic_partition.create_history_partition" = "true"
);

DROP TABLE IF EXISTS dws_trade_product_day;
CREATE TABLE dws_trade_product_day (
  dt                          DATE         NOT NULL COMMENT '统计日期',
  product_id                  BIGINT       NOT NULL COMMENT '商品id',
  order_cnt                   BIGINT                COMMENT '涉及订单数',
  item_rows                   BIGINT                COMMENT '明细行数（分叉率的分母）',
  item_qty                    BIGINT                COMMENT '销量（件）',
  buyer_cnt                   BIGINT                COMMENT '购买用户数（去重，不可加）',
  sale_amount_snapshot        DECIMAL(18,2)         COMMENT '口径A 快照价：SUM(quantity*unit_price) —— 业务正确',
  sale_amount_current_dim     DECIMAL(18,2)         COMMENT '口径B 当前维表价：SUM(quantity*dim_product.price) —— 错误示范',
  sale_amount_scd2            DECIMAL(18,2)         COMMENT '口径C SCD2版本价：SUM(quantity*scd2.price) —— 数据质量校验',
  sale_amount_net             DECIMAL(18,2)         COMMENT '净额：SUM(net_amount)（扣优惠）',
  diverged_rows               BIGINT                COMMENT '明细行级分叉数（unit_price != 当前价）',
  avg_abs_diff                DECIMAL(18,4)         COMMENT '行级平均绝对差',
  etl_time                    DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(dt, product_id)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(product_id) BUCKETS 8
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "8",
  "dynamic_partition.create_history_partition" = "true"
);

DROP TABLE IF EXISTS dws_trade_category_day;
CREATE TABLE dws_trade_category_day (
  dt                DATE         NOT NULL COMMENT '统计日期',
  category          VARCHAR(96)  NOT NULL COMMENT '品类',
  order_cnt         BIGINT                COMMENT '订单数',
  item_rows         BIGINT                COMMENT '明细行数（分叉率分母）',
  item_qty          BIGINT                COMMENT '销量',
  buyer_cnt         BIGINT                COMMENT '购买用户数（去重）',
  product_cnt       BIGINT                COMMENT '有销量商品数（去重）',
  sale_amount       DECIMAL(18,2)         COMMENT '销售额（快照价口径）',
  sale_amount_current_dim DECIMAL(18,2)   COMMENT '销售额（当前维表价口径，对照用）',
  diverged_rows     BIGINT                COMMENT '价格分叉明细行数',
  avg_abs_diff      DECIMAL(18,4)         COMMENT '行级平均绝对差',
  etl_time          DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(dt, category)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(category) BUCKETS 4
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "4",
  "dynamic_partition.create_history_partition" = "true"
);

DROP TABLE IF EXISTS dws_trade_province_day;
CREATE TABLE dws_trade_province_day (
  dt          DATE         NOT NULL COMMENT '统计日期',
  province    VARCHAR(96)  NOT NULL COMMENT '省份（用户所在地）',
  order_cnt   BIGINT                COMMENT '订单数',
  buyer_cnt   BIGINT                COMMENT '下单用户数（去重）',
  order_amount DECIMAL(18,2)        COMMENT '下单GMV',
  pay_amount  DECIMAL(18,2)         COMMENT '支付GMV',
  etl_time    DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(dt, province)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(province) BUCKETS 4
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "4",
  "dynamic_partition.create_history_partition" = "true"
);

DROP TABLE IF EXISTS dws_user_lifetime;
CREATE TABLE dws_user_lifetime (
  user_id          BIGINT       NOT NULL COMMENT '用户id',
  first_order_date DATE                 COMMENT '首次下单日期（R 的原料）',
  last_order_date  DATE                 COMMENT '最近下单日期（R 的原料）',
  order_cnt        BIGINT               COMMENT '累计订单数（F 的原料）',
  pay_cnt          BIGINT               COMMENT '累计支付订单数',
  complete_cnt     BIGINT               COMMENT '累计完成订单数',
  cancel_cnt       BIGINT               COMMENT '累计取消订单数',
  order_amount     DECIMAL(18,2)        COMMENT '累计下单GMV（M 的原料）',
  pay_amount       DECIMAL(18,2)        COMMENT '累计支付GMV',
  item_qty         BIGINT               COMMENT '累计件数',
  active_days      INT                  COMMENT '有下单的天数（去重）',
  etl_time         DATETIME             COMMENT 'ETL 写入时间'
) UNIQUE KEY(user_id)
DISTRIBUTED BY HASH(user_id) BUCKETS 8
PROPERTIES ("replication_num" = "1", "compression" = "ZSTD");

DROP TABLE IF EXISTS dws_product_stock_day;
CREATE TABLE dws_product_stock_day (
  dt                DATE         NOT NULL COMMENT '统计日期',
  product_id        BIGINT       NOT NULL COMMENT '商品id',
  day_open_stock    INT                   COMMENT '日初库存',
  day_end_stock     INT                   COMMENT '日末库存（★ 跨时间不可加）',
  day_deduct_qty    INT                   COMMENT '当日扣减量（负数）',
  day_replenish_qty INT                   COMMENT '当日补货量（正数）',
  day_net_change    INT                   COMMENT '当日净变动',
  change_cnt        INT                   COMMENT '当日变更次数',
  etl_time          DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(dt, product_id)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(product_id) BUCKETS 4
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "4",
  "dynamic_partition.create_history_partition" = "true"
);

CREATE DATABASE IF NOT EXISTS ads_eshop_10m;
USE ads_eshop_10m;

DROP TABLE IF EXISTS ads_trade_overview_day;
CREATE TABLE ads_trade_overview_day (
  dt              DATE         NOT NULL COMMENT '统计日期',
  order_cnt       BIGINT                COMMENT '下单订单数',
  order_amount    DECIMAL(18,2)         COMMENT '下单GMV',
  pay_cnt         BIGINT                COMMENT '支付订单数',
  pay_amount      DECIMAL(18,2)         COMMENT '支付GMV',
  complete_cnt    BIGINT                COMMENT '完成订单数',
  complete_amount DECIMAL(18,2)         COMMENT '完成GMV',
  cancel_cnt      BIGINT                COMMENT '取消订单数',
  cancel_rate     DECIMAL(10,4)         COMMENT '取消率（比率，终点层可落）',
  buyer_cnt       BIGINT                COMMENT '下单用户数（去重）',
  item_qty        BIGINT                COMMENT '件数',
  aov             DECIMAL(18,2)         COMMENT '客单价 = pay_amount / pay_cnt',
  unit_price_avg  DECIMAL(18,2)         COMMENT '件单价 = pay_amount / item_qty',
  etl_time        DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(dt)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(dt) BUCKETS 2
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "2",
  "dynamic_partition.create_history_partition" = "true"
);

DROP TABLE IF EXISTS ads_order_funnel_day;
CREATE TABLE ads_order_funnel_day (
  dt                DATE         NOT NULL COMMENT '统计日期',
  order_cnt         BIGINT                COMMENT '下单数（漏斗第 1 层）',
  paid_cnt          BIGINT                COMMENT '支付数（第 2 层）',
  shipped_cnt       BIGINT                COMMENT '发货数（第 3 层）',
  completed_cnt     BIGINT                COMMENT '完成数（第 4 层）',
  cancelled_cnt     BIGINT                COMMENT '取消数',
  paid_rate         DECIMAL(10,4)         COMMENT '支付率（比率，终点层可落）',
  ship_rate         DECIMAL(10,4)         COMMENT '发货率 / 支付',
  complete_rate     DECIMAL(10,4)         COMMENT '完成率 / 发货',
  avg_pay_sec       DECIMAL(18,2)         COMMENT '平均支付时长（秒）',
  avg_ship_sec      DECIMAL(18,2)         COMMENT '平均发货时长（秒）',
  avg_receive_sec   DECIMAL(18,2)         COMMENT '平均收货时长（秒）',
  etl_time          DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(dt)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(dt) BUCKETS 2
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "2",
  "dynamic_partition.create_history_partition" = "true"
);

DROP TABLE IF EXISTS ads_category_rank_day;
CREATE TABLE ads_category_rank_day (
  dt          DATE         NOT NULL COMMENT '统计日期',
  category    VARCHAR(96)  NOT NULL COMMENT '品类',
  rank_no     INT                   COMMENT '当日销售额排名',
  sale_amount DECIMAL(18,2)         COMMENT '销售额（快照价口径）',
  item_qty    BIGINT                COMMENT '销量',
  order_cnt   BIGINT                COMMENT '订单数',
  gmv_share   DECIMAL(10,4)         COMMENT '销售额占当日大盘比例',
  etl_time    DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(dt, category)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(category) BUCKETS 2
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "2",
  "dynamic_partition.create_history_partition" = "true"
);

DROP TABLE IF EXISTS ads_user_rfm;
CREATE TABLE ads_user_rfm (
  user_id        BIGINT       NOT NULL COMMENT '用户id',
  recency_days   INT                  COMMENT 'R：距区间末尾的天数',
  frequency      INT                  COMMENT 'F：累计订单数',
  monetary       DECIMAL(18,2)        COMMENT 'M：累计金额',
  r_score        TINYINT              COMMENT 'R 得分 1~5',
  f_score        TINYINT              COMMENT 'F 得分 1~5',
  m_score        TINYINT              COMMENT 'M 得分 1~5',
  rfm_segment    VARCHAR(96)          COMMENT '分层：重要价值/重要保持/…/一般发展',
  etl_time       DATETIME             COMMENT 'ETL 写入时间'
) UNIQUE KEY(user_id)
DISTRIBUTED BY HASH(user_id) BUCKETS 8
PROPERTIES ("replication_num" = "1", "compression" = "ZSTD");

DROP TABLE IF EXISTS ads_gmv_caliber_compare;
CREATE TABLE ads_gmv_caliber_compare (
  dt                       DATE         NOT NULL COMMENT '统计日期',
  gmv_snapshot             DECIMAL(18,2)         COMMENT '口径A 快照价（毛额）',
  gmv_current_dim          DECIMAL(18,2)         COMMENT '口径B 当前维表价（毛额）',
  gmv_scd2                 DECIMAL(18,2)         COMMENT '口径C SCD2 版本价（毛额）',
  gmv_net                  DECIMAL(18,2)         COMMENT '净额（扣优惠）',
  discount_total           DECIMAL(18,2)         COMMENT '优惠总额',
  diff_current_vs_snapshot DECIMAL(18,2)         COMMENT 'B - A',
  diff_pct_current         DECIMAL(12,6)         COMMENT '(B-A)/A，额级偏差（%）',
  diff_scd2_vs_snapshot    DECIMAL(18,2)         COMMENT 'C - A（应≈0，验证 SCD2 正确性）',
  diff_pct_scd2            DECIMAL(12,6)         COMMENT '(C-A)/A（%）',
  diverged_rows            BIGINT                COMMENT '行级分叉明细数',
  total_rows               BIGINT                COMMENT '明细总行数',
  diverged_pct             DECIMAL(12,6)         COMMENT '行级分叉率（%）',
  avg_abs_diff             DECIMAL(18,4)         COMMENT '行级平均绝对差（元）',
  etl_time                 DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(dt)
PARTITION BY RANGE(dt) ()
DISTRIBUTED BY HASH(dt) BUCKETS 2
PROPERTIES (
  "replication_num" = "1",
  "compression" = "ZSTD",
  "dynamic_partition.enable" = "true",
  "dynamic_partition.time_unit" = "DAY",
  "dynamic_partition.start" = "-40",
  "dynamic_partition.end" = "7",
  "dynamic_partition.prefix" = "p",
  "dynamic_partition.buckets" = "2",
  "dynamic_partition.create_history_partition" = "true"
);

DROP TABLE IF EXISTS ads_price_divergence_by_category;
CREATE TABLE ads_price_divergence_by_category (
  category       VARCHAR(96)  NOT NULL COMMENT '品类',
  total_rows     BIGINT                COMMENT '明细行数',
  diverged_rows  BIGINT                COMMENT '分叉行数',
  diverged_pct   DECIMAL(12,6)         COMMENT '分叉率（%）',
  avg_abs_diff   DECIMAL(18,4)         COMMENT '行级平均绝对差',
  gmv_snapshot   DECIMAL(18,2)         COMMENT '快照价 GMV',
  gmv_current_dim DECIMAL(18,2)        COMMENT '当前维表价 GMV',
  gmv_bias_pct   DECIMAL(12,6)         COMMENT '额级偏差（%）',
  etl_time       DATETIME              COMMENT 'ETL 写入时间'
) UNIQUE KEY(category)
DISTRIBUTED BY HASH(category) BUCKETS 2
PROPERTIES ("replication_num" = "1", "compression" = "ZSTD");

-- CREATE CATALOG paimon_eshop_10m PROPERTIES (
--   "type"             = "paimon",
--   "warehouse"        = "hdfs:///paimon/warehouse/eshop_10m",
--   "hadoop.username"  = "leoyi"
-- );
--   SHOW CATALOGS;
--   SELECT COUNT(*) FROM paimon_eshop_10m.dwd.fact_order_item;

SHOW DATABASES LIKE '%eshop_10m%';
