# 千万级数据规模实时湖仓平台

### 1、数据源说明
 本项目以模拟电商平台订单流为数据源，数据源说明为：[数据源说明.md](数据源说明.md)，开发过程以百万级规模验证数据链路，千万级规模进行查询优化实验。

数据规模统计信息如下：
| 规模 | 订单数 | 总行数 | 表数据大小 | 其中索引大小 | Binlog 大小 |
|---|---:|---:|---:|---:|---|
| **1m** | 100 万 | 2,811,111 | **0.72 GB** | 0.48 GB | 未单独实测（与 10m 混在同一段） |
| **10m** | 1000 万 | 27,497,808 | **6.85 GB** | 4.60 GB | **1.65 GB** |


### 2、实验内容
实验内容及结果在[实验结果记录.md](./实验记录/实验结果记录.md)，下方列出实验目录。

| # | 实验 | 归属规模 | 类型 | 
|---|---|---|:---:|
| 1 | CDC Changelog → Paimon Upsert 语义 | 100 万 | 正确性 |
| 2 | 架构选型 —— MySQL Flink CDC与Debezium CDC对比 | 100 万 | 正确性+选型 |
| 3 | GMV统计口径对比 | 100 万 | 建模 | 
| 4 | Paimon 分区裁剪（Partition Pruning） | 100 万 → 1000 万 | 性能 | 
| 5 | Paimon Bucket数量设置 | 1000 万 | 性能 | 
| 6 | Doris 分区裁剪 + Runtime Filter | 1000 万 | 性能 |
| 7 | Doris Colocate Join vs Shuffle Join | 1000 万 | 性能 | 
| 8 | Doris 物化视图 / 预聚合 | 1000 万 | 性能 | P1 |

### 3、集群环境说明

本项目基于VMware三节点集群进行，集群配置以及组件部署情况如下：
|节点|IP|CPU|内存|硬盘|部署组件进程|
|--|--|--|--|--|--|
|hadoop101|192.168.12.101|2处理器*2核心 = 4vCPU|24GB|200GB|NameNode、DataNode、NodeManager、Dinky、DorisFE、DorisBE、Kafka Broker|
|hadoop102|192.168.12.102|2处理器*2核心 = 4vCPU|24GB|200GB|DataNode、ResourceManager、NodeManager、DorisBE、Kafka Broker、Kafka Connect|
|hadoop103|192.168.12.103|2处理器*2核心 = 4vCPU|24GB|200GB|SecondaryNameNode、DataNode、NodeManager、DorisBE、MySQL(docker)、Kafka Broker|

**其中，核心组件版本如下：**
Hadoop版本：3.3.6 （JDK11）
Flink版本：1.19.3 （JDK17）
Paimon版本：1.4.2
Doris版本：4.0.7

### 4、数据链路

本项目基于**MySQL->Flink CDC->Paimon->Doris**数据链路进行实时数仓的开发，相关Flink SQL语句在实时数仓目录（`/实时数仓/1m`、`/实时数仓/10m`、`/实时数仓/100m`），分别代表百万级规模、千万级规模、亿级规模（受限于集群配置未全部运行）。

```
MySQL eshop_10m
   │  Flink CDC 作业（02）
   ▼
PAIMON · ODS 层（6 张）         
   │  6 个流式作业（04-streaming）+ 1 个批式作业（04-batch）
   ▼
PAIMON · DWD 层（7 张）          
   │
   │  ┌── 通路 A（07，Doris 直查 Paimon）─────┐
   └──┤                                        ├──► DORIS · DWS 层（6 张）
      └── 通路 B（08，Flink Stream Load）──────┘         │
              └──► DORIS · DWD 镜像层（6 张）            │  09（Doris 内算，<1 秒）
                                                         ▼
                                                  DORIS · ADS 层（6 张）
```


### 5、维度建模
按**4步法**进行建模

**(1)选择业务过程**
| 候选业务过程 | 数据源可得 | 有度量 | 有时刻 | 结论 |
|---|:---:|:---:|:---:|---|
| 用户下单 | ✅ | ✅ | ✅ | **采纳** |
| 用户支付 | ✅ | ✅ | ✅ | **采纳** |
| 商品发货 | ✅ | ✅ | ✅ | **采纳** |
| 用户收货 | ✅ | ✅ | ✅ | **采纳** |
| 订单取消 | ✅ | ✅ | ✅ | **采纳** |
| 商品调价 | ✅ | ✅ | ✅ | **采纳** |
| 下单扣减库存 | ⚠️ 表在 | ✅ | ✅ | **采纳** |
| 库存日快照 | ⚠️ 派生 | ✅ | ✅ | **采纳** |
| 退款退货 | ❌ | — | — | **不采纳** —— 数据源无此状态 |


**（2）声明粒度**

| 业务过程 | 声明粒度 | 说明 |
|---|---|---|
| 用户下单 | **订单明细级**（一行 = 一个订单里的一个商品） | 最原子级的数据。项目里同时保留订单级 `ods.fact_order`（1000 万行）与明细级 `ods.fact_order_item`（1699 万行）|
| 支付 / 发货 / 收货 / 取消 | **订单级**（一行 = 一个订单） | 累积快照事实表一行 = 一个订单的生命周期|
| 商品调价 | **商品 × 变更事件级** | 一行 = 一次调价 |
| 下单扣减库存 | **商品 × 变更事件级** | 一行 = 一次库存变动 |
| 库存日快照 | **商品 × 天**（周期快照） | 一行 = 某商品某天的库存 |

**（3）确认维度**
| 类别 | 维度 | 行数 | 说明 |
|---|---|---:|---|
| **一致性维度** | `dim_user` | 1,000,000 | 用户所在的省/市是用户属性，不是收货地 |
| | `dim_product` | 20,000 | 8 个品类 × 2,500 商品，完全均匀 |
| | `dim_date` | 62 | 日期维，覆盖事实数据的时间跨度 |
| **渐变维（SCD2）** | `dim_product_price_scd2` | 80,000 | 20,000 商品平均 **4 个价格版本**，带 `price_start_time` / `price_end_time` / `is_current` |
| **退化维** | `order_id` / `item_id` | — | 留在事实表里，不单独建维表 |
| **派生 / 层次维** | 品类、品牌 ⊂ 商品<br>省份、城市 ⊂ 用户<br>年/季/月/周 ⊂ 日期 | — | 从基础维度派生，用于上卷 |

**（4）确认事实**
 事实类型 | 字段 | 说明 |
|---|---|---|
| **可加事实** | `quantity`、`item_count`、`subtotal`、`net_amount`、`total_amount`、`discount_amount` | 任意维度可加 |
| **半可加事实** | `day_end_stock`（库存） | 跨时间不可加|
| **不可加事实** | `unit_price`、`gross_margin`、各种比率/占比 | 不可加，通过分子分母计算 |

**总线矩阵如下**
| 业务过程 | 粒度 | 用户 | 商品 | 时间 | 落地表 |
|---|---|:---:|:---:|:---:|---|
| 用户下单 | 订单明细 | ✅ | ✅ | ✅ | `dwd.fact_order_item`（订单级：`ods.fact_order`） | 
| 用户支付 | 订单 | ✅ | △ | ✅ | `dwd.fact_order_acc`.`pay_time` |
| 商品发货 | 订单 | ✅ | △ | ✅ | `dwd.fact_order_acc`.`shipping_time` | 
| 用户收货 | 订单 | ✅ | △ | ✅ | `dwd.fact_order_acc`.`complete_time` | 
| **订单取消** | 订单 | ✅ | △ | ✅ | `dwd.fact_order_acc`.`cancel_time` | 
| 下单扣减库存 | 商品 × 变更 | — | ✅ | ✅ | `ods.fact_stock_change` |
| 商品调价 | 商品 × 变更 | — | ✅ | ✅ | `ods.fact_product_price_change` + `dwd.dim_product_price_scd2` | 
| 库存日快照 | 商品 × 天 | — | ✅ | ✅ | `dwd.fact_product_stock_per_day` | 

✅直接关联 △间接关联  —不关联


### 6、数仓分层

数仓包含完整ODS->DWD->DWS->ADS四层，各层内容如下：

```
PAIMON ODS 层（6 张）
├── dim_user                        1,000,000   用户维（主键表）
├── dim_product                        20,000   商品维（主键表）
├── fact_order                     10,000,000   订单事实（主键表，按 order_date 分区）
├── fact_order_item                16,998,581   订单明细事实（主键表，按 order_date 分区）
├── fact_product_price_change          80,000   商品调价流水（append-only）
└── fact_stock_change                       0    库存变动流水（append-only）
```

```
PAIMON DWD 层（7 张）
├── dim_date                              62   日期维（①，流式）
├── dim_user                       1,000,000   用户维（②，流式）
├── dim_product                       20,000   商品维（③，流式）
├── dim_product_price_scd2            80,000   商品价格 SCD2 拉链表（④，流式）
├── fact_order_item               16,989,141   订单明细事实（⑤，流式，LOOKUP JOIN 商品维）
├── fact_order_acc                10,000,000   订单累积快照（⑥，流式，4 个里程碑 + 3 个时长字段）
└── fact_product_stock_per_day             0    商品日库存周期快照（⑦，批式）
```

```
DORIS DWS 层（6 张，db = dws_eshop_10m）
├── dws_trade_user_day            8,297,351   用户 × 天（交易主题）      ← dwd.fact_order_acc
├── dws_trade_product_day           588,194   商品 × 天（商品主题）      ← dwd.fact_order_item
├── dws_trade_category_day              248   品类 × 天（商品主题）      ← dwd.fact_order_item
├── dws_trade_province_day              310   省份 × 天（地域主题）      ← dwd.fact_order_acc
├── dws_user_lifetime               999,957   用户全生命周期（一行=一用户）← dwd.fact_order_acc
└── dws_product_stock_day                 0    商品 × 天 库存（周期快照）← dwd.fact_product_stock_per_day 
```

```
DORIS ADS 层（6 张，db = ads_eshop_10m）
├── ads_trade_overview_day                      31   交易大盘日看板        ← dws_trade_user_day
├── ads_order_funnel_day                        31   订单漏斗日（下单→支付→发货→完成）← dws_trade_user_day
├── ads_category_rank_day                      248   品类日排行（含排名+占比）← dws_trade_category_day
├── ads_user_rfm                           999,957   用户 RFM 分层         ← dws_user_lifetime
├── ads_gmv_caliber_compare                     31   三种 GMV 口径对比 ← dws_trade_product_day + dws_trade_user_day
└── ads_price_divergence_by_category             8   价格分叉按品类下钻      ← dws_trade_category_day
```