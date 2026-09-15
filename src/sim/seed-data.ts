/** 种子数据：8 大品类（品牌池 + 价格区间），省市表 */

export interface CategorySeed {
  name: string;
  brands: string[];
  /** [min, max] 价格区间（元），生成时取整到分 */
  priceRange: [number, number];
}

export const CATEGORIES: CategorySeed[] = [
  {
    name: '手机数码',
    brands: ['Apple', 'Huawei', 'Xiaomi', 'OPPO', 'vivo', 'Samsung'],
    priceRange: [999, 8999],
  },
  {
    name: '家用电器',
    brands: ['Midea', 'Gree', 'Haier', 'Philips', 'Dyson'],
    priceRange: [199, 6999],
  },
  {
    name: '服饰鞋包',
    brands: ['Nike', 'Adidas', 'Uniqlo', 'Zara', 'Li-Ning'],
    priceRange: [99, 1999],
  },
  {
    name: '美妆个护',
    brands: ['LOREAL', 'Olay', 'LANCOME', 'EsteeLauder', 'PerfectDiary'],
    priceRange: [49, 999],
  },
  {
    name: '食品生鲜',
    brands: ['ThreeSquirrels', 'Be&Cheery', 'Baicaowei', 'Yili', 'Mengniu'],
    priceRange: [9.9, 299],
  },
  {
    name: '运动户外',
    brands: ['Decathlon', 'Toread', 'TheNorthFace', 'Camel', 'ArcTeryx'],
    priceRange: [49, 2999],
  },
  {
    name: '图书文娱',
    brands: ['Zhonghua', 'RenminWenxue', 'CITIC', 'Guomai'],
    priceRange: [19.9, 199],
  },
  {
    name: '家居日用',
    brands: ['IKEA', 'MUJI', 'Yanxuan', 'MINISO'],
    priceRange: [9.9, 999],
  },
];

export interface ProvinceSeed {
  province: string;
  cities: string[];
}

export const PROVINCES: ProvinceSeed[] = [
  { province: '广东', cities: ['广州', '深圳', '东莞'] },
  { province: '浙江', cities: ['杭州', '宁波', '温州'] },
  { province: '江苏', cities: ['南京', '苏州', '无锡'] },
  { province: '上海', cities: ['上海'] },
  { province: '北京', cities: ['北京'] },
  { province: '四川', cities: ['成都', '绵阳'] },
  { province: '湖北', cities: ['武汉', '宜昌'] },
  { province: '湖南', cities: ['长沙', '株洲'] },
  { province: '福建', cities: ['厦门', '福州'] },
  { province: '山东', cities: ['青岛', '济南'] },
];

export const ORDER_STATUSES = [
  'CREATED',
  'PAID',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * 注册渠道（v2 新增）。
 * v1 完全没有渠道字段，导致"渠道 ROI""渠道转化率"这类指标无法计算。
 * 权重分布见 seed-generators.ts（App 45% / 小程序 25% / H5 15% / 线下 8% / 广告 7%）。
 */
export const CHANNELS = ['App', '小程序', 'H5', '线下门店', '广告投放'] as const;
export type Channel = (typeof CHANNELS)[number];
