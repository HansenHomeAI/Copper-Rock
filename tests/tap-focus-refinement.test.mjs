import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeScreenDistancePx,
    decodeFloat16,
    findClosestSampleToRay,
    sampleCpuPointsForFocus
} from '../tap-focus-refinement.mjs';

function approxEqual(actual, expected, epsilon = 1e-10) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `Expected ${expected}, got ${actual}`);
}

function encodeFloat16(value) {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 0x7e00 : (value < 0 ? 0xfc00 : 0x7c00);
    const floatView = new Float32Array(1);
    const intView = new Uint32Array(floatView.buffer);
    floatView[0] = value;
    const bits = intView[0];
    const sign = (bits >>> 16) & 0x8000;
    let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
    let mantissa = bits & 0x7fffff;

    if (exponent <= 0) {
        if (exponent < -10) return sign;
        mantissa = (mantissa | 0x800000) >> (1 - exponent);
        return sign | ((mantissa + 0x1000) >> 13);
    }

    if (exponent >= 31) return sign | 0x7c00;

    return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13);
}

function makeRng(seed) {
    let value = seed >>> 0;
    return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 0x100000000;
    };
}

function randInRange(rng, min, max) {
    return min + (max - min) * rng();
}

function referenceClosestSample({
    samples,
    rayOrigin,
    rayDirection,
    maxDistanceSq
}) {
    const length = Math.hypot(rayDirection.x, rayDirection.y, rayDirection.z);
    if (!(length > 1e-12)) return null;
    const dx = rayDirection.x / length;
    const dy = rayDirection.y / length;
    const dz = rayDirection.z / length;
    let bestOffset = -1;
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    let bestRayDistance = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < samples.length; offset += 3) {
        const px = samples[offset];
        const py = samples[offset + 1];
        const pz = samples[offset + 2];
        const vx = px - rayOrigin.x;
        const vy = py - rayOrigin.y;
        const vz = pz - rayOrigin.z;
        const rayDistance = vx * dx + vy * dy + vz * dz;
        if (rayDistance <= 0) continue;
        const cx = rayOrigin.x + dx * rayDistance;
        const cy = rayOrigin.y + dy * rayDistance;
        const cz = rayOrigin.z + dz * rayDistance;
        const ddx = px - cx;
        const ddy = py - cy;
        const ddz = pz - cz;
        const distanceSq = ddx * ddx + ddy * ddy + ddz * ddz;
        if (distanceSq > maxDistanceSq) continue;
        if (distanceSq < bestDistanceSq || (Math.abs(distanceSq - bestDistanceSq) <= 1e-12 && rayDistance < bestRayDistance)) {
            bestOffset = offset;
            bestDistanceSq = distanceSq;
            bestRayDistance = rayDistance;
        }
    }
    if (bestOffset < 0) return null;
    return { sampleOffset: bestOffset, distanceSq: bestDistanceSq, rayDistance: bestRayDistance };
}

test('decodeFloat16 decodes key values and edge cases', () => {
    assert.equal(decodeFloat16(0x0000), 0);
    assert.equal(Object.is(decodeFloat16(0x8000), -0), true);
    approxEqual(decodeFloat16(0x3c00), 1);
    approxEqual(decodeFloat16(0x4000), 2);
    approxEqual(decodeFloat16(0xc000), -2);
    approxEqual(decodeFloat16(0x7bff), 65504, 1e-7);
    assert.equal(Number.isNaN(decodeFloat16(0x7e00)), true);
    assert.equal(decodeFloat16(0x7c00), Infinity);
    assert.equal(decodeFloat16(0xfc00), -Infinity);
});

test('sampleCpuPointsForFocus samples and converts axes as expected', () => {
    const cpuPoints = new Uint16Array([
        encodeFloat16(1), encodeFloat16(2), encodeFloat16(3),
        encodeFloat16(-4), encodeFloat16(0.5), encodeFloat16(-2),
        encodeFloat16(6), encodeFloat16(-1), encodeFloat16(7)
    ]);
    const sampled = sampleCpuPointsForFocus({
        cpuPoints,
        pointCount: 3,
        targetSampleCount: 9
    });
    assert.ok(sampled);
    assert.equal(sampled.stride, 1);
    assert.equal(sampled.sampledPointCount, 3);
    const values = Array.from(sampled.samples);
    approxEqual(values[0], -1);
    approxEqual(values[1], -2);
    approxEqual(values[2], 3);
    approxEqual(values[3], 4);
    approxEqual(values[4], -0.5);
    approxEqual(values[5], -2);
    approxEqual(values[6], -6);
    approxEqual(values[7], 1);
    approxEqual(values[8], 7);
});

test('sampleCpuPointsForFocus respects stride for large point sets', () => {
    const values = [];
    for (let i = 0; i < 10; i += 1) {
        values.push(encodeFloat16(i + 1), encodeFloat16(i + 2), encodeFloat16(i + 3));
    }
    const sampled = sampleCpuPointsForFocus({
        cpuPoints: new Uint16Array(values),
        pointCount: 10,
        targetSampleCount: 3
    });
    assert.ok(sampled);
    assert.equal(sampled.stride, 4);
    assert.equal(sampled.sampledPointCount, 3);
    const s = Array.from(sampled.samples);
    approxEqual(s[0], -1);
    approxEqual(s[1], -2);
    approxEqual(s[2], 3);
    approxEqual(s[3], -5);
    approxEqual(s[4], -6);
    approxEqual(s[5], 7);
    approxEqual(s[6], -9);
    approxEqual(s[7], -10);
    approxEqual(s[8], 11);
});

test('findClosestSampleToRay finds nearest forward point and honors tie-breakers', () => {
    const samples = new Float32Array([
        0, 0, 5,
        1, 0, 2,
        1, 0, 4,
        0, 1, 3
    ]);
    const result = findClosestSampleToRay({
        samples,
        rayOrigin: { x: 0, y: 0, z: 0 },
        rayDirection: { x: 0, y: 0, z: 2 },
        maxDistanceSq: Number.POSITIVE_INFINITY
    });
    assert.ok(result);
    assert.equal(result.sampleOffset, 0);
    approxEqual(result.distanceSq, 0);

    const tieResult = findClosestSampleToRay({
        samples: new Float32Array([1, 0, 2, 1, 0, 4]),
        rayOrigin: { x: 0, y: 0, z: 0 },
        rayDirection: { x: 0, y: 0, z: 1 }
    });
    assert.ok(tieResult);
    assert.equal(tieResult.sampleOffset, 0);
    approxEqual(tieResult.rayDistance, 2);
});

test('findClosestSampleToRay rejects behind-ray and distant candidates', () => {
    const behindOnly = findClosestSampleToRay({
        samples: new Float32Array([0, 0, -4, 1, 0, -2]),
        rayOrigin: { x: 0, y: 0, z: 0 },
        rayDirection: { x: 0, y: 0, z: 1 }
    });
    assert.equal(behindOnly, null);

    const distanceLimited = findClosestSampleToRay({
        samples: new Float32Array([3, 0, 4]),
        rayOrigin: { x: 0, y: 0, z: 0 },
        rayDirection: { x: 0, y: 0, z: 1 },
        maxDistanceSq: 1
    });
    assert.equal(distanceLimited, null);
});

test('computeScreenDistancePx computes pixel offsets from NDC coordinates', () => {
    approxEqual(computeScreenDistancePx({
        ndcX: 0,
        ndcY: 0,
        viewportWidth: 1000,
        viewportHeight: 500,
        pointerX: 500,
        pointerY: 250
    }), 0);
    approxEqual(computeScreenDistancePx({
        ndcX: 1,
        ndcY: -1,
        viewportWidth: 1000,
        viewportHeight: 500,
        pointerX: 900,
        pointerY: 450
    }), Math.hypot(100, 50));
});

test('pressure test: ray selection stays equivalent to reference across 25k random trials', () => {
    const rng = makeRng(20260216);
    for (let trial = 0; trial < 25000; trial += 1) {
        const pointCount = 6 + Math.floor(randInRange(rng, 0, 40));
        const sampleArray = new Float32Array(pointCount * 3);
        for (let i = 0; i < pointCount * 3; i += 1) {
            sampleArray[i] = randInRange(rng, -12, 12);
        }
        const rayOrigin = {
            x: randInRange(rng, -2, 2),
            y: randInRange(rng, -2, 2),
            z: randInRange(rng, -2, 2)
        };
        const rayDirection = {
            x: randInRange(rng, -1, 1),
            y: randInRange(rng, -1, 1),
            z: randInRange(rng, -1, 1)
        };
        const limit = randInRange(rng, 0.001, 16);
        const actual = findClosestSampleToRay({
            samples: sampleArray,
            rayOrigin,
            rayDirection,
            maxDistanceSq: limit
        });
        const expected = referenceClosestSample({
            samples: sampleArray,
            rayOrigin,
            rayDirection,
            maxDistanceSq: limit
        });
        if (!expected) {
            assert.equal(actual, null);
            continue;
        }
        assert.ok(actual);
        assert.equal(actual.sampleOffset, expected.sampleOffset);
        approxEqual(actual.distanceSq, expected.distanceSq, 1e-9);
        approxEqual(actual.rayDistance, expected.rayDistance, 1e-9);
    }
});

