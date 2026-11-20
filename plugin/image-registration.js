// Match small luminance patches in the saved source and returned image. A single
// translation and uniform scale can fix reframing without warping the edit.
const SAMPLE_SIZE = 360;
const PATCH_RADIUS = 6;
const PATCH_STEP = 2;
const PATCH_AREA = 49;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.2;
const INLIER_ERROR = 2.3;

function matchPatch(source, result, width, height, x, y, offsets, radius, scores) {
    const values = offsets.map(offset => source[y * width + x + offset]);
    const mean = values.reduce((sum, value) => sum + value, 0) / PATCH_AREA;
    const patch = values.map(value => value - mean);
    const variance = patch.reduce((sum, value) => sum + value * value, 0);
    if (variance < PATCH_AREA * 144) return null;

    const left = Math.max(PATCH_RADIUS, x - radius);
    const top = Math.max(PATCH_RADIUS, y - radius);
    const right = Math.min(width - 1 - PATCH_RADIUS, x + radius);
    const bottom = Math.min(height - 1 - PATCH_RADIUS, y + radius);
    let best = 0.75, matchedX, matchedY, index = 0;
    for (let yy = top; yy <= bottom; yy++) {
        for (let xx = left; xx <= right; xx++) {
            const center = yy * width + xx;
            let sum = 0, squared = 0, dot = 0;
            for (let i = 0; i < PATCH_AREA; i++) {
                const value = result[center + offsets[i]];
                sum += value;
                squared += value * value;
                dot += value * patch[i];
            }
            const spread = squared - sum * sum / PATCH_AREA;
            const score = spread >= PATCH_AREA * 25 && dot > 0 ? dot / Math.sqrt(variance * spread) : 0;
            scores[index++] = score;
            if (score > best) {
                best = score;
                matchedX = xx;
                matchedY = yy;
            }
        }
    }

    if (matchedX === undefined) return null;
    index = 0;
    for (let yy = top; yy <= bottom; yy++) {
        for (let xx = left; xx <= right; xx++) {
            const score = scores[index++];
            if ((Math.abs(xx - matchedX) > 3 || Math.abs(yy - matchedY) > 3) && score > best - 0.037) return null;
        }
    }
    // Fit in pixel-center coordinates so the inverse can map canvas edges.
    return {x: x + 0.5, y: y + 0.5, u: matchedX + 0.5, v: matchedY + 0.5};
}

function findSimilarity(matches, width, height) {
    const minSupport = Math.max(8, Math.ceil(matches.length * 0.55));
    if (matches.length < minSupport) return null;
    const minBaseline = Math.min(width, height) * 0.28;
    const errorSquared = INLIER_ERROR ** 2;
    let best = [], bestError = Infinity;
    for (let i = 0; i < matches.length; i++) {
        const a = matches[i];
        for (let j = i + 1; j < matches.length; j++) {
            const b = matches[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const baseline = dx * dx + dy * dy;
            if (baseline < minBaseline * minBaseline) continue;
            const scale = (dx * (b.u - a.u) + dy * (b.v - a.v)) / baseline;
            if (scale < MIN_SCALE || scale > MAX_SCALE) continue;
            const tx = (a.u + b.u - scale * (a.x + b.x)) / 2;
            const ty = (a.v + b.v - scale * (a.y + b.y)) / 2;
            const inliers = [];
            let totalError = 0;
            for (const match of matches) {
                const {x, y, u, v} = match;
                const error = (u - scale * x - tx) ** 2 + (v - scale * y - ty) ** 2;
                if (error <= errorSquared) {
                    inliers.push(match);
                    totalError += error;
                }
            }
            if (inliers.length > best.length || (inliers.length === best.length && totalError < bestError)) {
                best = inliers;
                bestError = totalError;
            }
        }
    }

    const span = key => Math.max(...best.map(point => point[key])) - Math.min(...best.map(point => point[key]));
    if (best.length < minSupport || span('x') < width * 0.42 || span('y') < height * 0.42) return null;

    const mean = key => best.reduce((sum, point) => sum + point[key], 0) / best.length;
    const xCenter = mean('x'), yCenter = mean('y'), uCenter = mean('u'), vCenter = mean('v');
    let covariance = 0, variance = 0, originalError = 0;
    for (const {x, y, u, v} of best) {
        covariance += (x - xCenter) * (u - uCenter) + (y - yCenter) * (v - vCenter);
        variance += (x - xCenter) ** 2 + (y - yCenter) ** 2;
        originalError += (u - x) ** 2 + (v - y) ** 2;
    }
    const scale = covariance / variance, tx = uCenter - scale * xCenter, ty = vCenter - scale * yCenter;
    if (scale < MIN_SCALE || scale > MAX_SCALE) return null;
    const fittedError = best.reduce((sum, {x, y, u, v}) => sum + (u - scale * x - tx) ** 2 + (v - scale * y - ty) ** 2, 0);
    if (originalError / best.length < 1.5 ** 2) return {scale: 1, tx: 0, ty: 0};
    if (fittedError > originalError * 0.4) return null;
    return {scale, tx, ty};
}

function registerResult(source, result, capture, frame, selection) {
    const {width, height, pixels} = result;
    if (width < 32 || height < 32) return null;
    const scaleX = width / frame.width, scaleY = height / frame.height;
    const x0 = (capture.left - frame.left) * scaleX, y0 = (capture.top - frame.top) * scaleY;
    const captureWidth = capture.width * scaleX, captureHeight = capture.height * scaleY;
    const left = Math.max(0, Math.ceil(x0 - 0.5)), top = Math.max(0, Math.ceil(y0 - 0.5));
    const right = Math.min(width, Math.ceil(x0 + captureWidth - 0.5));
    const bottom = Math.min(height, Math.ceil(y0 + captureHeight - 0.5));
    const reference = new Uint8Array(width * height);
    // Put the source thumbnail into the coordinate system of the full upload,
    // excluding synthetic padding from the patches eligible to vote.
    for (let y = top; y < bottom; y++) {
        const row = Math.min(source.height - 1, Math.floor((y + 0.5 - y0) / captureHeight * source.height));
        for (let x = left; x < right; x++) {
            const col = Math.min(source.width - 1, Math.floor((x + 0.5 - x0) / captureWidth * source.width));
            reference[y * width + x] = source.pixels[row * source.width + col];
        }
    }

    const offsets = [];
    for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy += PATCH_STEP) {
        for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx += PATCH_STEP) offsets.push(dy * width + dx);
    }
    const radius = Math.ceil(Math.max(width, height) * 0.1);
    const scores = new Float32Array((radius * 2 + 1) ** 2);
    const matches = [];
    const stepX = Math.max(8, Math.ceil((right - left) / 22));
    const stepY = Math.max(8, Math.ceil((bottom - top) / 18));
    for (let y = top + PATCH_RADIUS + 1; y < bottom - PATCH_RADIUS; y += stepY) {
        for (let x = left + PATCH_RADIUS + 1; x < right - PATCH_RADIUS; x += stepX) {
            const match = matchPatch(reference, pixels, width, height, x, y, offsets, radius, scores);
            if (match) matches.push(match);
        }
    }

    const transform = findSimilarity(matches, right - left, bottom - top);
    if (!transform) return null;
    const {scale, tx, ty} = transform;
    if (scale === 1 && tx === 0 && ty === 0) return {bounds: frame, adjusted: false};

    // Invert the result's reframing in document coordinates. Reject corrections
    // that would expose a substantial portion of the original selection.
    const bounds = {
        left: frame.left - tx / (scale * scaleX),
        top: frame.top - ty / (scale * scaleY),
        width: frame.width / scale,
        height: frame.height / scale
    };
    const overhangX = Math.max(0, bounds.left - selection.left) + Math.max(0, selection.right - bounds.left - bounds.width);
    const overhangY = Math.max(0, bounds.top - selection.top) + Math.max(0, selection.bottom - bounds.top - bounds.height);
    if (overhangX > (selection.right - selection.left) * 0.06 || overhangY > (selection.bottom - selection.top) * 0.06) return null;
    return {bounds, adjusted: true};
}

module.exports = {SAMPLE_SIZE, registerResult};
