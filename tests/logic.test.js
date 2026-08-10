import { normalizePrimary, profileMatchesMonitor } from '../logic.js';

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

print('logic tests passed');
