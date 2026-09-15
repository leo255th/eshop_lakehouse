export interface CategorySeed {
    name: string;
    brands: string[];
    priceRange: [number, number];
}
export declare const CATEGORIES: CategorySeed[];
export interface ProvinceSeed {
    province: string;
    cities: string[];
}
export declare const PROVINCES: ProvinceSeed[];
export declare const ORDER_STATUSES: readonly ["CREATED", "PAID", "SHIPPED", "COMPLETED", "CANCELLED"];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export declare const CHANNELS: readonly ["App", "小程序", "H5", "线下门店", "广告投放"];
export type Channel = (typeof CHANNELS)[number];
