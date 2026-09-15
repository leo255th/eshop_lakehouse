"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ts = ts;
exports.generateUser = generateUser;
exports.generateProduct = generateProduct;
exports.generateOrder = generateOrder;
exports.buildPriceHistoryPerProduct = buildPriceHistoryPerProduct;
exports.buildPriceHistory = buildPriceHistory;
exports.priceAt = priceAt;
exports.finalPrice = finalPrice;
exports.generatePriceChanges = generatePriceChanges;
exports.initChangeRow = initChangeRow;
exports.priceChangesFromHistory = priceChangesFromHistory;
const seed_data_1 = require("../sim/seed-data");
const rng_1 = require("./rng");
const clock_service_1 = require("../clock/clock.service");
const TZ = '+08:00';
function ts(ms) {
    return clock_service_1.Clock.formatMs(ms, TZ);
}
const DAY_MS = 86_400_000;
function generateUser(i, seed, dataStartMs, regSpreadDays = 180) {
    const rng = new rng_1.Rng(seed + i * 7919);
    const user_id = i + 1;
    const region = rng.pick(seed_data_1.PROVINCES);
    const username = `user_${100000 + i}`;
    const regMs = dataStartMs - Math.floor(rng.float() * regSpreadDays * DAY_MS);
    const user_level = rng.weightedIndex([60, 30, 10]) + 1;
    const register_channel = seed_data_1.CHANNELS[rng.weightedIndex([45, 25, 15, 8, 7])];
    const deactivated = rng.bool(0.03);
    const deactMs = deactivated
        ? dataStartMs + Math.floor(rng.float() * 30 * DAY_MS)
        : null;
    const updMs = deactMs ?? regMs + Math.floor(rng.float() * 30 * DAY_MS);
    return {
        user_id,
        username,
        phone: (0, rng_1.randomPhone)(rng),
        email: `${username}@example.com`,
        province: region.province,
        city: rng.pick(region.cities),
        user_level,
        status: deactivated ? 0 : 1,
        register_channel,
        first_order_time: null,
        is_deleted: 0,
        deleted_time: null,
        create_time: ts(regMs),
        update_time: ts(Math.max(updMs, regMs)),
    };
}
function generateProduct(i, seed, dataStartMs, totalProducts) {
    const rng = new rng_1.Rng(seed + 104729 + i * 6151);
    const product_id = i + 1;
    const cat = seed_data_1.CATEGORIES[i % seed_data_1.CATEGORIES.length];
    const brand = rng.pick(cat.brands);
    const [minP, maxP] = cat.priceRange;
    const raw = rng.logNormal(0.9);
    const norm = Math.min(raw / 1.8, 1);
    const priceCents = Math.max(100, Math.round((minP + norm * (maxP - minP)) * 100));
    const costCents = Math.round(priceCents * (0.55 + rng.float() * 0.3));
    const offShelf = rng.bool(0.05);
    const offMs = offShelf ? dataStartMs + Math.floor(rng.float() * 30 * DAY_MS) : null;
    const createMs = dataStartMs - Math.floor(rng.float() * 90 * DAY_MS);
    return {
        product_id,
        product_name: `${brand} ${cat.name} ${String(i).padStart(5, '0')}`,
        category: cat.name,
        brand,
        price: (0, rng_1.fromCents)(priceCents),
        cost_price: (0, rng_1.fromCents)(costCents),
        stock: rng.int(0, 2000),
        status: offShelf ? 0 : 1,
        is_deleted: 0,
        deleted_time: null,
        create_time: ts(createMs),
        update_time: ts(Math.max(offMs ?? createMs, createMs)),
    };
}
const STATUS_NAMES = ['CREATED', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED'];
function statusWeights(ageDays) {
    if (ageDays > 14)
        return [1, 2, 3, 90, 4];
    if (ageDays > 7)
        return [2, 4, 6, 82, 6];
    if (ageDays > 3)
        return [5, 10, 12, 65, 8];
    if (ageDays > 1)
        return [12, 22, 18, 38, 10];
    return [30, 30, 15, 10, 15];
}
function generateOrder(orderIndex, ctx, itemIdStart) {
    const rng = new rng_1.Rng(ctx.seed + 999983 + orderIndex * 31337);
    const order_id = orderIndex + 1;
    let orderMs;
    if (ctx.eventTimeMs !== undefined) {
        const jitterMs = ctx.streamJitterMs ?? 60_000;
        orderMs = ctx.eventTimeMs - Math.floor(rng.float() * jitterMs);
    }
    else {
        orderMs = (0, rng_1.sampleEventTime)(rng, ctx.dataStartMs, ctx.dataEndMs, ctx.pattern, 0.6);
    }
    if (ctx.lateRatio > 0 && rng.float() < ctx.lateRatio) {
        orderMs -= rng.int(1000, ctx.lateMaxMs);
        if (orderMs < ctx.dataStartMs)
            orderMs = ctx.dataStartMs;
    }
    const ageDays = (ctx.dataEndMs - orderMs) / DAY_MS;
    const user_id = rng.int(1, ctx.userCount);
    const itemCount = rng.weightedIndex(ctx.itemCountWeights) + 1;
    const chosen = new Set();
    let guard = 0;
    while (chosen.size < itemCount && guard++ < itemCount * 10) {
        const pid = rng.int(1, ctx.productCount);
        if (ctx.productStatus[pid - 1] === 1)
            chosen.add(pid);
    }
    if (chosen.size === 0)
        chosen.add(1);
    let totalCents = 0;
    let totalQty = 0;
    let totalDiscountCents = 0;
    const items = [];
    let itemId = itemIdStart;
    for (const pid of chosen) {
        const qty = rng.weightedIndex(ctx.qtyWeights) + 1;
        const unitPriceCents = ctx.priceHistory && ctx.basePriceCents
            ? priceAt(ctx.priceHistory, pid - 1, orderMs, ctx.basePriceCents)
            : ctx.productPriceCents[pid - 1];
        const subtotalCents = unitPriceCents * qty;
        let discountCents = 0;
        if (rng.bool(0.3)) {
            discountCents = Math.round(subtotalCents * rng.range(0, 0.15));
        }
        totalCents += subtotalCents - discountCents;
        totalQty += qty;
        totalDiscountCents += discountCents;
        items.push({
            item_id: itemId++,
            order_id,
            product_id: pid,
            quantity: qty,
            unit_price: (0, rng_1.fromCents)(unitPriceCents),
            subtotal: (0, rng_1.fromCents)(subtotalCents),
            discount_amount: (0, rng_1.fromCents)(discountCents),
            create_time: ts(orderMs),
        });
    }
    const weights = statusWeights(ageDays);
    let status = STATUS_NAMES[rng.weightedIndex(weights)];
    if (status !== 'COMPLETED' && status !== 'CANCELLED' && rng.float() < ctx.cancelRatio) {
        status = 'CANCELLED';
    }
    const cap = ctx.dataEndMs;
    const at = (base, loMin, hiMin) => Math.min(base + rng.int(loMin * 60_000, hiMin * 60_000), cap);
    let payMs = null;
    let shipMs = null;
    let completeMs = null;
    let cancelMs = null;
    switch (status) {
        case 'PAID':
            payMs = at(orderMs, 1, 30);
            break;
        case 'SHIPPED':
            payMs = at(orderMs, 1, 30);
            shipMs = at(payMs, 30, 240);
            break;
        case 'COMPLETED':
            payMs = at(orderMs, 1, 30);
            shipMs = at(payMs, 30, 240);
            completeMs = at(shipMs, 120, 2880);
            break;
        case 'CANCELLED':
            if (rng.bool(0.5)) {
                payMs = at(orderMs, 1, 30);
                cancelMs = at(payMs, 5, 180);
            }
            else {
                cancelMs = at(orderMs, 1, 120);
            }
            break;
        default:
            break;
    }
    const updateMs = Math.max(orderMs, ...[payMs, shipMs, completeMs, cancelMs].filter((v) => v !== null));
    return {
        order: {
            order_id,
            user_id,
            order_status: status,
            item_count: totalQty,
            total_amount: (0, rng_1.fromCents)(totalCents),
            discount_amount: (0, rng_1.fromCents)(totalDiscountCents),
            pay_time: payMs === null ? null : ts(payMs),
            shipping_time: shipMs === null ? null : ts(shipMs),
            complete_time: completeMs === null ? null : ts(completeMs),
            cancel_time: cancelMs === null ? null : ts(cancelMs),
            order_time: ts(orderMs),
            update_time: ts(updateMs),
            is_deleted: 0,
            deleted_time: null,
        },
        items,
    };
}
function buildPriceHistoryPerProduct(productCount, seed, dataStartMs, dataEndMs, changesPerProduct, basePrices) {
    const counts = new Int32Array(productCount);
    const times = [];
    const prices = [];
    const epochBaseMs = dataStartMs;
    for (let i = 0; i < productCount; i++) {
        const n = Math.max(0, Math.round(changesPerProduct[i] ?? 0));
        counts[i] = n;
        if (n === 0) {
            times.push(new Int32Array(0));
            prices.push(new Int32Array(0));
            continue;
        }
        const rng = new rng_1.Rng(seed + 15485863 + i * 24593);
        const rawTimes = [];
        for (let k = 0; k < n; k++) {
            rawTimes.push(rng.int(dataStartMs, dataEndMs - 1));
        }
        rawTimes.sort((a, b) => a - b);
        const tArr = new Int32Array(n);
        const pArr = new Int32Array(n);
        let prev = basePrices[i];
        for (let k = 0; k < n; k++) {
            tArr[k] = Math.round((rawTimes[k] - epochBaseMs) / 1000);
            const delta = Math.round(prev * rng.range(-0.1, 0.1));
            const next = Math.max(100, prev + delta);
            pArr[k] = next;
            prev = next;
        }
        times.push(tArr);
        prices.push(pArr);
    }
    return { times, prices, counts, epochBaseMs };
}
function buildPriceHistory(productCount, seed, dataStartMs, dataEndMs, changesPerProduct, basePrices) {
    const arr = new Int32Array(productCount).fill(Math.max(0, Math.round(changesPerProduct)));
    return buildPriceHistoryPerProduct(productCount, seed, dataStartMs, dataEndMs, arr, basePrices);
}
function priceAt(h, productIndex, atMs, basePrices) {
    const n = h.counts[productIndex];
    if (n === 0)
        return basePrices[productIndex];
    const tArr = h.times[productIndex];
    const target = Math.round((atMs - h.epochBaseMs) / 1000);
    let lo = 0;
    let hi = n - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tArr[mid] <= target) {
            found = mid;
            lo = mid + 1;
        }
        else {
            hi = mid - 1;
        }
    }
    return found >= 0 ? h.prices[productIndex][found] : basePrices[productIndex];
}
function finalPrice(h, productIndex, basePrices) {
    const n = h.counts[productIndex];
    return n === 0 ? basePrices[productIndex] : h.prices[productIndex][n - 1];
}
function generatePriceChanges(i, ctx, changesPerProduct) {
    if (changesPerProduct <= 0)
        return [];
    const rng = new rng_1.Rng(ctx.seed + 15485863 + i * 24593);
    const product_id = i + 1;
    const baseCents = ctx.productPriceCents[i];
    const n = Math.max(1, Math.round(changesPerProduct));
    const out = [];
    const times = [];
    for (let k = 0; k < n; k++) {
        times.push(rng.int(ctx.dataStartMs, ctx.dataEndMs - 1));
    }
    times.sort((a, b) => a - b);
    let prevCents = baseCents;
    for (let k = 0; k < n; k++) {
        const delta = Math.round(prevCents * rng.range(-0.1, 0.1));
        const newCents = Math.max(100, prevCents + delta);
        const isOff = rng.bool(0.03);
        out.push({
            product_id,
            old_price: (0, rng_1.fromCents)(prevCents),
            new_price: (0, rng_1.fromCents)(newCents),
            change_type: isOff ? 'OFFSHELF' : 'ADJUST',
            change_time: ts(times[k]),
        });
        prevCents = newCents;
    }
    return out;
}
function initChangeRow(productIndex, basePriceCents, dataStartMs) {
    return {
        product_id: productIndex + 1,
        old_price: null,
        new_price: (0, rng_1.fromCents)(basePriceCents),
        change_type: 'INIT',
        change_time: ts(dataStartMs),
    };
}
function priceChangesFromHistory(h, productIndex, basePriceCents, totalChanges) {
    const n = h.counts[productIndex];
    if (n === 0)
        return [];
    const product_id = productIndex + 1;
    const tArr = h.times[productIndex];
    const pArr = h.prices[productIndex];
    const out = [];
    let prev = basePriceCents;
    for (let k = 0; k < n; k++) {
        const flagRng = new rng_1.Rng(h.epochBaseMs + productIndex * 131 + k * 17 + totalChanges);
        const isOff = flagRng.bool(0.03);
        out.push({
            product_id,
            old_price: (0, rng_1.fromCents)(prev),
            new_price: (0, rng_1.fromCents)(pArr[k]),
            change_type: isOff ? 'OFFSHELF' : 'ADJUST',
            change_time: ts(h.epochBaseMs + tArr[k] * 1000),
        });
        prev = pArr[k];
    }
    return out;
}
//# sourceMappingURL=seed-generators.js.map