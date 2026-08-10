export function normalizePrimary(values) {
    const primaryIndex = Math.max(0, values.findIndex(Boolean));
    return values.map((_value, index) => index === primaryIndex);
}

export function profileMatchesMonitor(profile, monitorSpec) {
    if (!monitorSpec)
        return false;

    const identity = ['vendor', 'product', 'serial'];
    if (!identity.some(property => Object.hasOwn(profile, property)))
        return true;

    return identity.every((property, index) => profile[property] === monitorSpec[index + 1]);
}

export function monitorApplyProperties(properties = {}) {
    const result = {};
    const names = [
        ['is-underscanning', 'underscanning'],
        ['color-mode', 'color-mode'],
        ['rgb-range', 'rgb-range'],
    ];

    for (const [source, target] of names) {
        if (Object.hasOwn(properties, source))
            result[target] = properties[source];
    }

    return result;
}

export function scaleSupported(supportedScales, scale, layoutMode) {
    if (!Number.isFinite(scale) || scale <= 0)
        return false;
    if (layoutMode === 2 && !Number.isInteger(scale))
        return false;
    if (!supportedScales || supportedScales.length === 0)
        return true;
    return supportedScales.some(value => Math.abs(value - scale) < 0.01);
}

function monitorSize(entry, layoutMode) {
    const mode = entry.mode;
    let width = mode[1];
    let height = mode[2];
    if ([1, 3, 5, 7].includes(entry.transform))
        [width, height] = [height, width];
    if (layoutMode === 1) {
        width /= entry.scale;
        height /= entry.scale;
    }
    return [Math.round(width), Math.round(height)];
}

function layoutsTouch(a, b) {
    const horizontal = (a.x + a.width === b.x || b.x + b.width === a.x) &&
        Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
    const vertical = (a.y + a.height === b.y || b.y + b.height === a.y) &&
        Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x);
    return horizontal || vertical;
}

function layoutsOverlap(a, b) {
    return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
        Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
}

export function normalizeLayout(entries, layoutMode) {
    const minX = Math.min(...entries.map(entry => entry.x));
    const minY = Math.min(...entries.map(entry => entry.y));
    const rectangles = entries.map((entry, index) => {
        const [width, height] = monitorSize(entry, layoutMode);
        return {
            index,
            x: entry.x - minX,
            y: entry.y - minY,
            width,
            height,
        };
    });

    let valid = true;
    for (let i = 0; i < rectangles.length; i++) {
        for (let j = i + 1; j < rectangles.length; j++) {
            if (layoutsOverlap(rectangles[i], rectangles[j]))
                valid = false;
        }
    }

    const connected = new Set([0]);
    while (connected.size < rectangles.length) {
        const next = rectangles.findIndex((rectangle, index) =>
            !connected.has(index) && [...connected].some(connectedIndex =>
                layoutsTouch(rectangle, rectangles[connectedIndex])));
        if (next < 0)
            break;
        connected.add(next);
    }

    if (valid && connected.size === rectangles.length)
        return rectangles.map(({ x, y }) => ({ x, y }));

    const ordered = [...rectangles].sort((a, b) => a.x - b.x || a.y - b.y);
    let x = 0;
    const result = Array(rectangles.length);
    for (const rectangle of ordered) {
        result[rectangle.index] = { x, y: 0 };
        x += rectangle.width;
    }
    return result;
}
