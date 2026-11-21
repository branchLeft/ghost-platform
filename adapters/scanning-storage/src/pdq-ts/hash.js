"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hammingDistance = hammingDistance;
exports.toHex = toHex;
exports.toBase64 = toBase64;
const pdq_js_1 = require("./pdq.js");
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function assertHash(hash, name) {
    if (hash.length !== pdq_js_1.HASH_BYTES) {
        throw new RangeError(`${name}: a PDQ hash is exactly ${pdq_js_1.HASH_BYTES} bytes, got ${hash.length}`);
    }
}
function bitCount(byte) {
    let bits = 0;
    for (let x = byte; x !== 0; x >>= 1) {
        bits += x & 1;
    }
    return bits;
}
// Number of differing bits between two hashes, 0 to 256.
function hammingDistance(a, b) {
    assertHash(a, 'hammingDistance');
    assertHash(b, 'hammingDistance');
    let bits = 0;
    for (let i = 0; i < pdq_js_1.HASH_BYTES; i += 1) {
        bits += bitCount(a[i] ^ b[i]);
    }
    return bits;
}
// The reference's own text form: 64 lowercase hex characters, byte 0 first.
function toHex(hash) {
    assertHash(hash, 'toHex');
    let text = '';
    for (let i = 0; i < pdq_js_1.HASH_BYTES; i += 1) {
        text += hash[i].toString(16).padStart(2, '0');
    }
    return text;
}
// Canonical padded base64 of the 32 bytes: always 44 characters ending in '='.
function toBase64(hash) {
    assertHash(hash, 'toBase64');
    let text = '';
    // 32 bytes are ten groups of three and one group of two, so every group
    // has its second byte and only the last lacks its third.
    for (let i = 0; i < pdq_js_1.HASH_BYTES; i += 3) {
        const b0 = hash[i];
        const b1 = hash[i + 1];
        const b2 = i + 2 < pdq_js_1.HASH_BYTES ? hash[i + 2] : 0;
        const group = (b0 << 16) | (b1 << 8) | b2;
        text += BASE64_ALPHABET[(group >> 18) & 63];
        text += BASE64_ALPHABET[(group >> 12) & 63];
        text += BASE64_ALPHABET[(group >> 6) & 63];
        text += i + 2 < pdq_js_1.HASH_BYTES ? BASE64_ALPHABET[group & 63] : '=';
    }
    return text;
}
