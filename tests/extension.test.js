import Gio from 'gi://Gio';
import * as Logic from '../logic.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}

const file = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
    .get_child('extension.js');
const [, bytes] = file.load_contents(null);
const source = new TextDecoder().decode(bytes)
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export default class', 'return class');
const sources = new Map();
let nextId = 1;
let writes = 0;
const GLib = {
    PRIORITY_DEFAULT: 0, PRIORITY_LOW: 1, SOURCE_REMOVE: false,
    idle_add: (_priority, callback) => add(callback),
    timeout_add: (_priority, _ms, callback) => add(callback),
    source_remove: id => sources.delete(id),
    file_set_contents: () => { writes++; return true; },
    Variant: class { constructor(_type, value) { this.value = value; } },
};
function add(callback) {
    const id = nextId++;
    sources.set(id, callback);
    return id;
}
function run(id) {
    const callback = sources.get(id);
    sources.delete(id);
    callback();
}
const Meta = { MonitorSwitchConfigType: { ALL_LINEAR: 1, BUILTIN: 2, EXTERNAL: 3 } };
const names = ['Extension', 'SwitchMonitor', 'Meta', 'Gio', 'GLib', ...Object.keys(Logic)];
const ExtensionClass = new Function(...names, source)(
    class {}, {}, Meta, { DBusProxy: { makeProxyWrapper: () => class {} } },
    GLib, ...Object.values(Logic));
function extension() {
    return Object.assign(new ExtensionClass(), {
        _enabled: true, _generation: 1, _restoreGeneration: 0,
        _snapshotGeneration: 0, _memory: {}, _switchTimeoutId: 0,
        _restoreSourceId: 0, _restoreInFlight: false,
        _pendingRestoreType: null, _ignoreSnapshotSourceId: 0,
    });
}

const ext = extension();
let restores = 0;
ext._applyPersistedConfig = (_type, done) => { restores++; done(); };
ext._waitForSwitch(1);
ext._queueRestore();
assert(restores === 0 && ext._restoreSourceId === 0, 'waits for signal');
ext._restoreReady = true;
ext._queueRestore();
run(ext._restoreSourceId);
assert(restores === 1 && !ext._suppressSnapshot, 'restores after signal');
ext._waitForSwitch(1);
run(ext._switchTimeoutId);
assert(ext._pendingRestoreType === null && !ext._suppressSnapshot,
    'timeout releases suppression without applying');
assert(ext._snapshotGeneration === 2, 'switches invalidate snapshots');

ext._memory = { scale: 1 };
ext._saveMemory();
ext._saveMemory();
assert(writes === 1, 'unchanged memory is not written');

const stale = extension();
let snapshotCallback;
stale._proxy = { GetCurrentStateRemote: callback => { snapshotCallback = callback; } };
stale._snapshotActiveMonitors();
stale._waitForSwitch(1);
run(stale._switchTimeoutId);
snapshotCallback([1, [], [], {}], null);
assert(Object.keys(stale._memory).length === 0 && writes === 1,
    'stale snapshot cannot save after suppression ends');

ext._waitForSwitch(1);
ext._restoreReady = true;
ext._queueRestore();
const queued = ext._restoreSourceId;
ext._waitForSwitch(2);
run(queued);
assert(restores === 1, 'queued restore cannot run before newer switch signal');
run(ext._switchTimeoutId);

const specA = ['A', 'vendor', 'panel', 'a'];
const specB = ['B', 'vendor', 'panel', 'b'];
const mode = ['mode', 1920, 1080, 60, 1, [1], { 'is-current': true }];
const monitors = [[specA, [mode], {}], [specB, [mode], {}]];
const layout = [[0, 0, 1, 0, true, [specA]], [1920, 0, 1, 0, false, [specB]]];
const state = [1, monitors, layout, { 'layout-mode': 1 }];
function applyTest(memory, failFull = false) {
    const instance = extension();
    instance._memory = memory;
    const calls = [];
    instance._proxy = {
        GetCurrentStateRemote: callback => callback(state, null),
        ApplyMonitorsConfigRemote: (_serial, _method, logical, _props, callback) => {
            calls.push(logical);
            callback(null, failFull && calls.length === 2 ? new Error('test failure') : null);
        },
    };
    let finished = 0;
    instance._applyPersistedConfig(1, () => finished++, 0);
    assert(finished === 1, 'completion called once');
    return calls;
}
assert(applyTest({}).length === 0, 'unchanged configuration is not applied');
const saved = { A: { x: 0, y: 0, primary: false }, B: { x: 1920, y: 0, primary: true } };
assert(applyTest(saved).length === 2, 'primary workaround completes full layout');
const recovered = applyTest(saved, true);
assert(recovered.length === 3 && recovered[0].length === 1 &&
    recovered[2].length === 2 && recovered[2][0][4],
    'failed full apply recovers original primary and both displays');
layout[1][0] = 3840;
const repaired = applyTest({});
assert(repaired.length === 1 && repaired[0][1][0] === 1920,
    'normalization alone triggers an apply');

print('extension tests passed');
