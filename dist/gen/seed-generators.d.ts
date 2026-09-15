import { TimePattern } from './rng';
export declare function ts(ms: number): string;
export interface UserRow {
    user_id: number;
    username: string;
    phone: string;
    email: string;
    province: string;
    city: string;
    user_level: number;
    status: number;
    register_channel: string;
    first_order_time: string | null;
    is_deleted: number;
    deleted_time: string | null;
    create_time: string;
    update_time: string;
}
export declare function generateUser(i: number, seed: number, dataStartMs: number, regSpreadDays?: number): UserRow;
export interface ProductRow {
    product_id: number;
    product_name: string;
    category: string;
    brand: string;
    price: string;
    cost_price: string;
    stock: number;
    status: number;
    is_deleted: number;
    deleted_time: string | null;
    create_time: string;
    update_time: string;
}
export declare function generateProduct(i: number, seed: number, dataStartMs: number, totalProducts: number): ProductRow;
declare const STATUS_NAMES: readonly ["CREATED", "PAID", "SHIPPED", "COMPLETED", "CANCELLED"];
export type OrderStatus = (typeof STATUS_NAMES)[number];
export interface OrderRow {
    order_id: number;
    user_id: number;
    order_status: OrderStatus;
    item_count: number;
    total_amount: string;
    discount_amount: string;
    pay_time: string | null;
    shipping_time: string | null;
    complete_time: string | null;
    cancel_time: string | null;
    order_time: string;
    update_time: string;
    is_deleted: number;
    deleted_time: string | null;
}
export interface OrderGenContext {
    seed: number;
    dataStartMs: number;
    dataEndMs: number;
    pattern: TimePattern;
    userCount: number;
    productCount: number;
    itemCountWeights: number[];
    qtyWeights: number[];
    cancelRatio: number;
    lateRatio: number;
    lateMaxMs: number;
    productPriceCents: Int32Array;
    productStatus: Uint8Array;
    priceHistory?: PriceHistory;
    basePriceCents?: Int32Array;
    eventTimeMs?: number;
    streamJitterMs?: number;
}
export interface OrderWithItems {
    order: OrderRow;
    items: ItemRow[];
}
export interface ItemRow {
    item_id: number;
    order_id: number;
    product_id: number;
    quantity: number;
    unit_price: string;
    subtotal: string;
    discount_amount: string;
    create_time: string;
}
export declare function generateOrder(orderIndex: number, ctx: OrderGenContext, itemIdStart: number): OrderWithItems;
export interface PriceHistory {
    times: Int32Array[];
    prices: Int32Array[];
    counts: Int32Array;
    epochBaseMs: number;
}
export declare function buildPriceHistoryPerProduct(productCount: number, seed: number, dataStartMs: number, dataEndMs: number, changesPerProduct: Int32Array, basePrices: Int32Array): PriceHistory;
export declare function buildPriceHistory(productCount: number, seed: number, dataStartMs: number, dataEndMs: number, changesPerProduct: number, basePrices: Int32Array): PriceHistory;
export declare function priceAt(h: PriceHistory, productIndex: number, atMs: number, basePrices: Int32Array): number;
export declare function finalPrice(h: PriceHistory, productIndex: number, basePrices: Int32Array): number;
export interface PriceChangeRow {
    product_id: number;
    old_price: string | null;
    new_price: string;
    change_type: string;
    change_time: string;
}
export declare function generatePriceChanges(i: number, ctx: OrderGenContext, changesPerProduct: number): PriceChangeRow[];
export declare function initChangeRow(productIndex: number, basePriceCents: number, dataStartMs: number): PriceChangeRow;
export declare function priceChangesFromHistory(h: PriceHistory, productIndex: number, basePriceCents: number, totalChanges: number): PriceChangeRow[];
export {};
