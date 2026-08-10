import {
    monitorApplyProperties,
    normalizeLayout,
    normalizePrimary,
    profileMatchesMonitor,
    scaleSupported,
} from '../logic.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: got ${JSON.stringify(actual)}`);
}

assertEqual(normalizePrimary([false, false]), [true, false], 'adds a primary');
assertEqual(normalizePrimary([false, true]), [false, true], 'keeps one primary');
assertEqual(normalizePrimary([true, true]), [true, false], 'removes duplicate primaries');

const spec = ['HDMI-1', 'Acme', 'Panel', '123'];
assertEqual(profileMatchesMonitor({}, spec), true, 'accepts legacy profiles');
assertEqual(profileMatchesMonitor({ vendor: 'Acme', product: 'Panel', serial: '123' }, spec), true,
    'accepts the same monitor');
assertEqual(profileMatchesMonitor({ vendor: 'Other', product: 'Panel', serial: '123' }, spec), false,
    'rejects a replacement monitor');
assertEqual(profileMatchesMonitor({}, null), false, 'rejects a missing monitor');

assertEqual(scaleSupported([1, 1.25, 2], 1.25, 1), true,
    'allows fractional logical scales');
assertEqual(scaleSupported([1, 1.25, 2], 1.25, 2), false,
    'rejects fractional physical scales');
assertEqual(scaleSupported([1, 2], 1.5, 1), false, 'rejects an unsupported scale');

assertEqual(monitorApplyProperties({
    'is-underscanning': true,
    'color-mode': 2,
    'rgb-range': 1,
    'display-name': 'ignored',
}), {
    underscanning: true,
    'color-mode': 2,
    'rgb-range': 1,
}, 'preserves writable monitor properties');

const mode = ['mode', 1920, 1080];
assertEqual(normalizeLayout([
    { x: 0, y: 0, scale: 1, transform: 0, mode },
    { x: 1920, y: 0, scale: 1, transform: 0, mode },
], 1), [{ x: 0, y: 0 }, { x: 1920, y: 0 }], 'keeps a connected layout');
assertEqual(normalizeLayout([
    { x: 0, y: 0, scale: 1, transform: 0, mode },
    { x: 3840, y: 0, scale: 1, transform: 0, mode },
], 1), [{ x: 0, y: 0 }, { x: 1920, y: 0 }], 'compacts a disconnected layout');
assertEqual(normalizeLayout([
    { x: 0, y: 0, scale: 2, transform: 0, mode },
    { x: 960, y: 0, scale: 1, transform: 1, mode },
], 1), [{ x: 0, y: 0 }, { x: 960, y: 0 }], 'uses logical transformed dimensions');

print('logic tests passed');
