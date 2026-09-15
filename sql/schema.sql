
CREATE DATABASE IF NOT EXISTS `__DB__`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `__DB__`;

CREATE TABLE IF NOT EXISTS dim_user (
    user_id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '用户ID',
    username         VARCHAR(64)  NOT NULL COMMENT '用户名',
    phone            VARCHAR(20)  NOT NULL COMMENT '手机号',
    email            VARCHAR(128) DEFAULT NULL,
    province         VARCHAR(32)  DEFAULT NULL COMMENT '省份（用户所在地，非收货地）',
    city             VARCHAR(32)  DEFAULT NULL COMMENT '城市（用户所在地，非收货地）',
    user_level       TINYINT      NOT NULL DEFAULT 1 COMMENT '1普通 2银牌 3金牌',
    status           TINYINT      NOT NULL DEFAULT 1 COMMENT '1正常 0已注销',
    -- v2 新增：渠道维度。v1 完全没有渠道字段，导致渠道分析类指标无法计算
    register_channel VARCHAR(32)  NOT NULL DEFAULT 'App'
                     COMMENT '注册渠道: App/小程序/H5/线下门店/广告投放（v2 新增）',
    -- v2 新增：首单时间。用于"新客"口径（数仓学习笔记 03 §3.3）
    --   注意：也可由 fact_order 推导，但预计算可避免实时链路维护大状态
    first_order_time DATETIME(3)  DEFAULT NULL COMMENT '首次下单时间（v2 新增，新客判定用）',
    -- v2 新增：软删标记。解决"硬删导致历史指标口径漂移"
    is_deleted       TINYINT      NOT NULL DEFAULT 0 COMMENT '1已删除 0正常（v2 新增，逻辑删除）',
    deleted_time     DATETIME(3)  DEFAULT NULL COMMENT '删除时间（v2 新增）',
    create_time      DATETIME(3)  NOT NULL COMMENT '注册时间（由应用显式写入虚拟时钟时间）',
    update_time      DATETIME(3)  NOT NULL COMMENT '最近变更时间（由应用显式写入，无 ON UPDATE）',
    PRIMARY KEY (user_id),
    KEY idx_city (city),
    KEY idx_channel (register_channel),
    KEY idx_status_update (status, update_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户维表';

CREATE TABLE IF NOT EXISTS dim_product (
    product_id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_name VARCHAR(128) NOT NULL,
    category     VARCHAR(32)  NOT NULL COMMENT '品类（8 大品类）',
    brand        VARCHAR(64)  DEFAULT NULL,
    price        DECIMAL(10,2) NOT NULL COMMENT '当前售价（会变化）',
    -- v2 新增：成本价。用于毛利、毛利率分析（v1 只有售价，无法算利润）
    cost_price   DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '成本价（v2 新增，毛利分析用）',
    stock        INT          NOT NULL DEFAULT 0,
    status       TINYINT      NOT NULL DEFAULT 1 COMMENT '1上架 0下架',
    -- v2 新增：软删标记（同上）
    is_deleted   TINYINT      NOT NULL DEFAULT 0 COMMENT '1已删除 0正常（v2 新增）',
    deleted_time DATETIME(3)  DEFAULT NULL COMMENT '删除时间（v2 新增）',
    create_time  DATETIME(3)  NOT NULL COMMENT '创建时间（应用显式写入）',
    update_time  DATETIME(3)  NOT NULL COMMENT '最近变更时间（应用显式写入，无 ON UPDATE）',
    PRIMARY KEY (product_id),
    KEY idx_category (category),
    KEY idx_brand (brand),
    KEY idx_status_update (status, update_time),
    KEY idx_price (price)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品维表';

CREATE TABLE IF NOT EXISTS fact_order (
    order_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id       BIGINT UNSIGNED NOT NULL,
    order_status  VARCHAR(16)  NOT NULL DEFAULT 'CREATED'
                  COMMENT 'CREATED/PAID/SHIPPED/COMPLETED/CANCELLED',
    item_count    INT          NOT NULL DEFAULT 0 COMMENT '商品总件数',
    total_amount  DECIMAL(12,2) NOT NULL DEFAULT 0.00
                  COMMENT '订单总金额（= 明细 subtotal 之和 - 明细 discount 之和）',
    -- v2 新增：优惠金额（可加事实，用于折扣分析）
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00
                  COMMENT '订单优惠总额（v2 新增）',
    pay_time      DATETIME(3)  DEFAULT NULL COMMENT '支付时间',
    -- v2 新增：三个里程碑时间戳
    shipping_time DATETIME(3)  DEFAULT NULL COMMENT '发货时间（v2 新增）',
    complete_time DATETIME(3)  DEFAULT NULL COMMENT '完成时间（v2 新增）',
    cancel_time   DATETIME(3)  DEFAULT NULL COMMENT '取消时间（v2 新增）',
    order_time    DATETIME(3)  NOT NULL COMMENT '下单时间=事件时间，落库后不变',
    update_time   DATETIME(3)  NOT NULL COMMENT '最近变更时间（应用显式写入，无 ON UPDATE）',
    -- v2 新增：逻辑删除。清理器不再物理 DELETE，避免历史指标口径漂移
    is_deleted    TINYINT      NOT NULL DEFAULT 0
                  COMMENT '1已逻辑删除 0正常（v2 新增；物理删除可选）',
    deleted_time  DATETIME(3)  DEFAULT NULL COMMENT '删除时间（v2 新增）',
    PRIMARY KEY (order_id),
    KEY idx_user (user_id),
    KEY idx_order_time (order_time),
    KEY idx_status (order_status),
    -- v2 新增：清理器删除条件专用索引（v1 完全没有可用索引，全表扫）
    --   查询形如 WHERE order_status='CANCELLED' AND update_time < ?
    KEY idx_status_update (order_status, update_time),
    -- v2 新增：用户维度 + 时间 的组合分析（周期快照 dws_user_daily 的来源）
    KEY idx_user_time (user_id, order_time),
    -- v2 新增：时间 + 状态 组合（按天统计各状态订单数）
    KEY idx_time_status (order_time, order_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单主表';

CREATE TABLE IF NOT EXISTS fact_order_item (
    item_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id    BIGINT UNSIGNED NOT NULL,
    product_id  BIGINT UNSIGNED NOT NULL,
    quantity    INT         NOT NULL,
    unit_price  DECIMAL(10,2) NOT NULL COMMENT '下单瞬间的价格快照，之后不变',
    subtotal    DECIMAL(12,2) NOT NULL COMMENT 'quantity * unit_price（优惠前）',
    -- v2 新增：明细级优惠金额
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00
                    COMMENT '明细优惠金额（v2 新增）',
    create_time DATETIME(3) NOT NULL COMMENT '下单时间（应用显式写入，与 order_time 同值）',
    PRIMARY KEY (item_id),
    KEY idx_order (order_id),
    KEY idx_product (product_id),
    KEY idx_create_time (create_time),
    -- v2 新增：商品 + 时间（周期快照 dws_product_daily 的来源）
    KEY idx_product_time (product_id, create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单明细表（事实快照）';

CREATE TABLE IF NOT EXISTS fact_product_price_change (
    change_id    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id   BIGINT UNSIGNED NOT NULL,
    old_price    DECIMAL(10,2) DEFAULT NULL COMMENT '变更前价格（首次上架为 NULL）',
    new_price    DECIMAL(10,2) NOT NULL COMMENT '变更后价格',
    change_type  VARCHAR(16)   NOT NULL DEFAULT 'ADJUST'
                 COMMENT 'ADJUST调价/OFFSHELF下架/ONSHELF上架/INIT初始',
    change_time  DATETIME(3)   NOT NULL COMMENT '变更时间（虚拟时钟时间）',
    PRIMARY KEY (change_id),
    KEY idx_product_time (product_id, change_time),
    KEY idx_change_time (change_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品价格变更流水（无事实事实表）';


CREATE TABLE IF NOT EXISTS fact_stock_change (
    change_id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id  BIGINT UNSIGNED NOT NULL,
    order_id    BIGINT UNSIGNED DEFAULT NULL COMMENT '关联订单（下单扣减时有值）',
    change_type VARCHAR(16)   NOT NULL DEFAULT 'ORDER_DEDUCT'
                COMMENT 'ORDER_DEDUCT下单扣减/REPLENISH补货/ADJUST调整/INIT初始',
    delta       INT           NOT NULL COMMENT '变动量（负数为扣减）',
    stock_after INT           NOT NULL COMMENT '变动后库存',
    change_time DATETIME(3)   NOT NULL COMMENT '变更时间',
    PRIMARY KEY (change_id),
    KEY idx_product_time (product_id, change_time),
    KEY idx_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存变更流水（无事实事实表）';


-- 测试表
CREATE TABLE IF NOT EXISTS cdc_test (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    create_time_ms BIGINT NOT NULL
                   COMMENT '写入时刻 epoch 毫秒（真实墙钟）★ 延迟锚点 ★',
    create_time    DATETIME(3) NOT NULL
                   COMMENT '同上时刻的可读形式（+08:00 墙钟），仅核对用',
    source_time    DATETIME(3) DEFAULT NULL
                   COMMENT 'binlog 事件时间(秒级精度)；MySQL 侧恒为 NULL，由 CDC 填入',
    sink_time      DATETIME(3) DEFAULT NULL
                   COMMENT 'Flink 写入 Paimon 时刻；MySQL 侧恒为 NULL，由 Flink 填入',
    PRIMARY KEY (id),
    KEY idx_create_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='实验2 CDC 端到端延迟/吞吐 基准表';
