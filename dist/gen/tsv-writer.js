"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TsvWriter = exports.NULL_TOKEN = void 0;
exports.escapeField = escapeField;
exports.toTsvLine = toTsvLine;
exports.shardFileName = shardFileName;
const fs_1 = require("fs");
const events_1 = require("events");
exports.NULL_TOKEN = '\\N';
function escapeField(v) {
    if (v === null || v === undefined)
        return exports.NULL_TOKEN;
    const s = typeof v === 'string' ? v : String(v);
    if (s === '')
        return '';
    if (s.includes('\t') || s.includes('\n') || s.includes('\r') || s.includes('\\')) {
        return s
            .replace(/\\/g, '\\\\')
            .replace(/\t/g, '\\t')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n');
    }
    return s;
}
function toTsvLine(fields) {
    let line = escapeField(fields[0]);
    for (let i = 1; i < fields.length; i++) {
        line += '\t' + escapeField(fields[i]);
    }
    return line + '\n';
}
class TsvWriter {
    path;
    stream;
    buffer = [];
    bufferedBytes = 0;
    flushAtBytes;
    drainThreshold = 4 * 1024 * 1024;
    rowsWritten = 0;
    bytesWritten = 0;
    constructor(path, opts = {}) {
        this.path = path;
        this.flushAtBytes = opts.flushBytes ?? 1 * 1024 * 1024;
        this.stream = (0, fs_1.createWriteStream)(path, { flags: 'w', highWaterMark: 1 << 20 });
    }
    write(fields) {
        const line = toTsvLine(fields);
        this.buffer.push(line);
        this.bufferedBytes += line.length;
        this.rowsWritten++;
        if (this.bufferedBytes >= this.flushAtBytes) {
            this.flushSync();
        }
    }
    writeRaw(line) {
        this.buffer.push(line);
        this.bufferedBytes += line.length;
        this.rowsWritten++;
        if (this.bufferedBytes >= this.flushAtBytes) {
            this.flushSync();
        }
    }
    flushSync() {
        if (this.buffer.length === 0)
            return;
        const chunk = this.buffer.join('');
        this.buffer = [];
        this.bytesWritten += Buffer.byteLength(chunk);
        this.bufferedBytes = 0;
        const ok = this.stream.write(chunk);
        if (!ok) {
            this.pendingDrain = true;
        }
    }
    pendingDrain = false;
    async close() {
        this.flushSync();
        this.stream.end();
        await (0, events_1.once)(this.stream, 'finish');
    }
    get needsDrain() {
        return this.pendingDrain;
    }
    async drain() {
        if (!this.pendingDrain)
            return;
        this.pendingDrain = false;
        if (this.stream.writableNeedDrain) {
            await (0, events_1.once)(this.stream, 'drain');
        }
    }
}
exports.TsvWriter = TsvWriter;
function shardFileName(tmpDir, table, shard, sizeKey) {
    return `${tmpDir}/${table}_${sizeKey}_s${String(shard).padStart(3, '0')}.tsv`;
}
//# sourceMappingURL=tsv-writer.js.map