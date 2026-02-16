const HALF_FLOAT_SIGN_MASK = 0x8000;
const HALF_FLOAT_EXPONENT_MASK = 0x7c00;
const HALF_FLOAT_FRACTION_MASK = 0x03ff;
const HALF_FLOAT_EXPONENT_SHIFT = 10;
const HALF_FLOAT_MAX_EXPONENT = 0x1f;
const DEFAULT_TARGET_SAMPLE_COUNT = 18000;

export function decodeFloat16(value) {
    if (!Number.isFinite(value)) return NaN;
    const bits = value & 0xffff;
    const sign = (bits & HALF_FLOAT_SIGN_MASK) ? -1 : 1;
    const exponent = (bits & HALF_FLOAT_EXPONENT_MASK) >> HALF_FLOAT_EXPONENT_SHIFT;
    const fraction = bits & HALF_FLOAT_FRACTION_MASK;

    if (exponent === 0) {
        return fraction === 0
            ? sign * 0
            : sign * 2 ** -14 * (fraction / 1024);
    }

    if (exponent === HALF_FLOAT_MAX_EXPONENT) {
        return fraction === 0 ? sign * Infinity : NaN;
    }

    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function sampleCpuPointsForFocus({
    cpuPoints,
    pointCount,
    targetSampleCount = DEFAULT_TARGET_SAMPLE_COUNT
} = {}) {
    if (!cpuPoints || typeof cpuPoints.length !== 'number' || cpuPoints.length < 3) return null;
    const availablePointCount = Math.floor(cpuPoints.length / 3);
    const requestedPointCount = Number.isFinite(pointCount)
        ? Math.max(0, Math.floor(pointCount))
        : availablePointCount;
    const sourcePointCount = Math.min(requestedPointCount, availablePointCount);
    if (!sourcePointCount) return null;

    const normalizedTargetSampleCount = Number.isFinite(targetSampleCount) && targetSampleCount > 0
        ? Math.floor(targetSampleCount)
        : DEFAULT_TARGET_SAMPLE_COUNT;
    const stride = Math.max(1, Math.ceil(sourcePointCount / normalizedTargetSampleCount));
    const estimatedSampledPointCount = Math.ceil(sourcePointCount / stride);
    let samples = new Float32Array(estimatedSampledPointCount * 3);
    let writeOffset = 0;

    for (let pointIndex = 0; pointIndex < sourcePointCount; pointIndex += stride) {
        const sourceOffset = pointIndex * 3;
        const x = -decodeFloat16(cpuPoints[sourceOffset]);
        const y = -decodeFloat16(cpuPoints[sourceOffset + 1]);
        const z = decodeFloat16(cpuPoints[sourceOffset + 2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        samples[writeOffset] = x;
        samples[writeOffset + 1] = y;
        samples[writeOffset + 2] = z;
        writeOffset += 3;
    }

    if (!writeOffset) return null;
    if (writeOffset !== samples.length) {
        samples = samples.slice(0, writeOffset);
    }

    return {
        samples,
        stride,
        sourcePointCount,
        sampledPointCount: samples.length / 3
    };
}

export function findClosestSampleToRay({
    samples,
    rayOrigin,
    rayDirection,
    maxDistanceSq = Number.POSITIVE_INFINITY
} = {}) {
    if (!samples || samples.length < 3 || !rayOrigin || !rayDirection) return null;
    let directionX = rayDirection.x;
    let directionY = rayDirection.y;
    let directionZ = rayDirection.z;
    const directionLength = Math.hypot(directionX, directionY, directionZ);
    if (!(directionLength > 1e-12)) return null;
    directionX /= directionLength;
    directionY /= directionLength;
    directionZ /= directionLength;

    const originX = rayOrigin.x;
    const originY = rayOrigin.y;
    const originZ = rayOrigin.z;
    if (!Number.isFinite(originX) || !Number.isFinite(originY) || !Number.isFinite(originZ)) return null;
    const distanceSqLimit = Number.isFinite(maxDistanceSq) && maxDistanceSq >= 0
        ? maxDistanceSq
        : Number.POSITIVE_INFINITY;

    let bestOffset = -1;
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    let bestRayDistance = Number.POSITIVE_INFINITY;

    for (let offset = 0; offset < samples.length; offset += 3) {
        const pointX = samples[offset];
        const pointY = samples[offset + 1];
        const pointZ = samples[offset + 2];

        const toPointX = pointX - originX;
        const toPointY = pointY - originY;
        const toPointZ = pointZ - originZ;
        const rayDistance = toPointX * directionX + toPointY * directionY + toPointZ * directionZ;
        if (rayDistance <= 0) continue;

        const closestPointX = originX + directionX * rayDistance;
        const closestPointY = originY + directionY * rayDistance;
        const closestPointZ = originZ + directionZ * rayDistance;

        const deltaX = pointX - closestPointX;
        const deltaY = pointY - closestPointY;
        const deltaZ = pointZ - closestPointZ;
        const distanceSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
        if (distanceSq > distanceSqLimit) continue;

        if (distanceSq < bestDistanceSq || (Math.abs(distanceSq - bestDistanceSq) <= 1e-12 && rayDistance < bestRayDistance)) {
            bestDistanceSq = distanceSq;
            bestRayDistance = rayDistance;
            bestOffset = offset;
        }
    }

    if (bestOffset < 0) return null;
    return {
        sampleOffset: bestOffset,
        x: samples[bestOffset],
        y: samples[bestOffset + 1],
        z: samples[bestOffset + 2],
        distanceSq: bestDistanceSq,
        rayDistance: bestRayDistance
    };
}

export function computeScreenDistancePx({
    ndcX,
    ndcY,
    viewportWidth,
    viewportHeight,
    pointerX,
    pointerY
} = {}) {
    if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return Number.POSITIVE_INFINITY;
    const screenX = (ndcX + 1) * 0.5 * viewportWidth;
    const screenY = (1 - ndcY) * 0.5 * viewportHeight;
    return Math.hypot(screenX - pointerX, screenY - pointerY);
}

