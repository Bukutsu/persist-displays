import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as SwitchMonitor from 'resource:///org/gnome/shell/ui/switchMonitor.js';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    hasMultiplePrimaries,
    monitorApplyProperties,
    normalizeLayout,
    normalizePrimary,
    primaryMonitorConnector,
    profileMatchesMonitor,
    scaleSupported,
} from './logic.js';

const DisplayConfigIface = `
<node>
  <interface name="org.gnome.Mutter.DisplayConfig">
    <method name="GetCurrentState">
      <arg type="u" direction="out"/>
      <arg type="a((ssss)a(siiddada{sv})a{sv})" direction="out"/>
      <arg type="a(iiduba(ssss)a{sv})" direction="out"/>
      <arg type="a{sv}" direction="out"/>
    </method>
    <method name="ApplyMonitorsConfig">
      <arg type="u" direction="in"/>
      <arg type="u" direction="in"/>
      <arg type="a(iiduba(ssa{sv}))" direction="in"/>
      <arg type="a{sv}" direction="in"/>
    </method>
    <signal name="MonitorsChanged"/>
  </interface>
</node>`;

const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);
const TEMPORARY_CONFIG = 1;

function unpack(value) {
    return value && typeof value.unpack === 'function' ? value.unpack() : value;
}

function hasOwn(object, property) {
    return object && Object.prototype.hasOwnProperty.call(object, property);
}

export default class PersistDisplaysExtension extends Extension {
    enable() {
        this._enabled = true;
        this._generation = (this._generation ?? 0) + 1;
        const generation = this._generation;
        this._configFile = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'persist-displays.json',
        ]);
        this._memory = this._loadMemory();
        this._savedMemory = JSON.stringify(this._memory);
        this._switchTimeoutId = 0;
        this._restoreReady = false;
        this._suppressSnapshot = false;
        this._restoreSourceId = 0;
        this._restoreInFlight = false;
        this._restoreGeneration = 0;
        this._pendingRestoreType = null;
        this._snapshotSourceId = 0;
        this._snapshotInFlight = false;
        this._snapshotAgain = false;
        this._snapshotGeneration = 0;
        this._ignoreSnapshotSourceId = 0;

        this._proxy = null;
        new DisplayConfigProxy(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            (proxy, error) => {
                if (!this._enabled || generation !== this._generation)
                    return;
                if (error) {
                    console.error('[PersistDisplays] Failed to connect to DisplayConfig:', error);
                    return;
                }

                this._proxy = proxy;
                this._signalId = proxy.connectSignal('MonitorsChanged', () => {
                    if (this._pendingRestoreType !== null) {
                        this._restoreReady = true;
                        this._queueRestore();
                    } else if (!this._suppressSnapshot) {
                        this._queueSnapshot();
                    }
                });
                this._queueSnapshot();
            }
        );

        const prototype = SwitchMonitor.SwitchMonitorPopup.prototype;
        this._originalFinish = prototype._finish;
        const originalFinish = this._originalFinish;
        const extension = this;
        this._finishWrapper = function () {
            if (!extension._enabled) {
                originalFinish.call(this);
                return;
            }

            const item = this._items[this._selectedIndex];
            const configType = item && item.configType;

            if (extension._shouldRestore(configType)) {
                extension._waitForSwitch(configType);
                originalFinish.call(this);
                return;
            }

            if (configType === Meta.MonitorSwitchConfigType.ALL_MIRROR)
                extension._ignoreNextSnapshot();
            originalFinish.call(this);
        };
        prototype._finish = this._finishWrapper;
    }

    _shouldRestore(configType) {
        if (configType === undefined)
            return false;

        return configType === Meta.MonitorSwitchConfigType.ALL_LINEAR ||
            configType === Meta.MonitorSwitchConfigType.BUILTIN ||
            configType === Meta.MonitorSwitchConfigType.EXTERNAL;
    }

    _ignoreNextSnapshot() {
        if (this._ignoreSnapshotSourceId)
            GLib.source_remove(this._ignoreSnapshotSourceId);
        if (this._snapshotSourceId) {
            GLib.source_remove(this._snapshotSourceId);
            this._snapshotSourceId = 0;
        }
        if (this._restoreSourceId) {
            GLib.source_remove(this._restoreSourceId);
            this._restoreSourceId = 0;
        }

        if (this._switchTimeoutId) {
            GLib.source_remove(this._switchTimeoutId);
            this._switchTimeoutId = 0;
        }
        this._restoreReady = false;
        this._suppressSnapshot = true;
        this._pendingRestoreType = null;
        this._restoreGeneration++;
        this._snapshotAgain = false;
        this._snapshotGeneration++;
        this._ignoreSnapshotSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            2000,
            () => {
                this._ignoreSnapshotSourceId = 0;
                this._suppressSnapshot = false;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _waitForSwitch(configType) {
        if (this._ignoreSnapshotSourceId) {
            GLib.source_remove(this._ignoreSnapshotSourceId);
            this._ignoreSnapshotSourceId = 0;
        }

        if (this._switchTimeoutId)
            GLib.source_remove(this._switchTimeoutId);
        this._suppressSnapshot = true;
        this._snapshotGeneration++;
        this._snapshotAgain = false;
        this._pendingRestoreType = configType;
        this._restoreReady = false;
        this._restoreGeneration++;
        // A no-op switch may emit no signal. Leave GNOME's configuration alone.
        this._switchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._switchTimeoutId = 0;
            this._pendingRestoreType = null;
            this._restoreReady = false;
            this._restoreGeneration++;
            this._suppressSnapshot = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueRestore() {
        if (!this._restoreReady || this._restoreSourceId || this._restoreInFlight)
            return;

        const generation = this._generation;
        this._restoreSourceId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._restoreSourceId = 0;
            if (!this._restoreReady || this._pendingRestoreType === null)
                return GLib.SOURCE_REMOVE;
            if (this._switchTimeoutId) {
                GLib.source_remove(this._switchTimeoutId);
                this._switchTimeoutId = 0;
            }
            this._restoreReady = false;
            const pendingType = this._pendingRestoreType;
            const restoreGeneration = this._restoreGeneration;
            this._pendingRestoreType = null;
            this._restoreInFlight = true;
            this._applyPersistedConfig(pendingType, () => {
                if (generation !== this._generation)
                    return;

                this._restoreInFlight = false;
                if (this._pendingRestoreType !== null)
                    this._queueRestore();
                else if (restoreGeneration === this._restoreGeneration)
                    this._suppressSnapshot = false;
            }, restoreGeneration);
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadMemory() {
        try {
            if (GLib.file_test(this._configFile, GLib.FileTest.EXISTS)) {
                const [ok, contents] = GLib.file_get_contents(this._configFile);
                if (ok) {
                    const memory = JSON.parse(new TextDecoder('utf-8').decode(contents));
                    if (memory && typeof memory === 'object' && !Array.isArray(memory))
                        return memory;
                }
            }
        } catch (e) {
            console.error('[PersistDisplays] Failed to load memory:', e);
        }
        return {};
    }

    _saveMemory() {
        try {
            const serialized = JSON.stringify(this._memory);
            if (serialized === this._savedMemory)
                return;
            const data = new TextEncoder().encode(serialized);
            if (GLib.file_set_contents(this._configFile, data))
                this._savedMemory = serialized;
        } catch (e) {
            console.error('[PersistDisplays] Failed to save memory:', e);
        }
    }

    _queueSnapshot() {
        if (!this._enabled || this._suppressSnapshot || this._snapshotSourceId)
            return;
        if (this._snapshotInFlight) {
            this._snapshotAgain = true;
            return;
        }

        this._snapshotSourceId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._snapshotSourceId = 0;
            this._snapshotActiveMonitors();
            return GLib.SOURCE_REMOVE;
        });
    }

    _snapshotActiveMonitors() {
        const proxy = this._proxy;
        if (!this._enabled || !proxy || this._suppressSnapshot)
            return;
        if (this._snapshotInFlight) {
            this._snapshotAgain = true;
            return;
        }

        this._snapshotInFlight = true;
        const snapshotGeneration = this._snapshotGeneration;
        proxy.GetCurrentStateRemote((result, error) => {
            if (proxy !== this._proxy)
                return;

            this._snapshotInFlight = false;
            if (snapshotGeneration !== this._snapshotGeneration)
                return;
            if (!this._enabled || this._suppressSnapshot) {
                this._snapshotAgain = false;
                return;
            }
            if (error || !result) {
                if (this._snapshotAgain) {
                    this._snapshotAgain = false;
                    this._queueSnapshot();
                }
                return;
            }

            const [, monitors, logicalMonitors, properties] = result;
            const mirrored = logicalMonitors.some(logicalMonitor =>
                logicalMonitor[5].length > 1);
            const layoutMode = unpack(properties?.['layout-mode']);
            if (!mirrored && [1, 2].includes(layoutMode))
                this._memory.layout_mode = layoutMode;
            const monitorMap = new Map(monitors.map(monitor => [
                monitor[0][0],
                monitor,
            ]));

            const primaries = normalizePrimary(logicalMonitors.map(lm => Boolean(lm[4])));
            for (let i = 0; i < logicalMonitors.length; i++) {
                const logicalMonitor = logicalMonitors[i];
                const [x, y, scale, transform, , monitorSpecs] = logicalMonitor;
                const primary = primaries[i];
                if (monitorSpecs.length > 1)
                    continue;

                for (const monitorSpec of monitorSpecs) {
                    const connector = monitorSpec[0];
                    const monitor = monitorMap.get(connector);
                    const existing = this._memory[connector];
                    const profile = existing && typeof existing === 'object' &&
                        !Array.isArray(existing) &&
                        profileMatchesMonitor(existing, monitor?.[0])
                        ? existing
                        : {};

                    profile.scale = scale;
                    profile.transform = transform;

                    if (monitor) {
                        const [spec] = monitor;
                        profile.vendor = spec[1];
                        profile.product = spec[2];
                        profile.serial = spec[3];
                    }
                    const currentMode = monitor && monitor[1].find(mode =>
                        unpack(mode[6]?.['is-current']) === true);
                    if (currentMode)
                        profile.mode_id = currentMode[0];

                    if (logicalMonitors.length > 1) {
                        profile.x = x;
                        profile.y = y;
                        profile.primary = primary;
                    }

                    this._memory[connector] = profile;
                }
            }

            this._saveMemory();
            if (this._snapshotAgain) {
                this._snapshotAgain = false;
                this._queueSnapshot();
            }
        });
    }

    _currentMode(monitor) {
        if (!monitor || !monitor[1])
            return null;

        return monitor[1].find(mode =>
            unpack(mode[6]?.['is-current']) === true) || monitor[1][0] || null;
    }

    _modeForId(monitor, modeId, fallback) {
        if (!monitor || !monitor[1])
            return null;

        return monitor[1].find(mode => mode[0] === modeId) || fallback;
    }

    _scaleSupported(mode, scale, layoutMode) {
        return scaleSupported(mode && unpack(mode[5]), scale, layoutMode);
    }

    _chooseScale(entries, currentScale, layoutMode) {
        const supports = scale => entries.every(entry =>
            this._scaleSupported(entry.selectedMode, scale, layoutMode));
        const saved = entries.find(entry =>
            entry.saved && hasOwn(entry.saved, 'scale'));
        const preferredMode = entries.find(entry => entry.selectedMode)?.selectedMode;
        const candidates = [
            saved && saved.saved.scale,
            currentScale,
            preferredMode && preferredMode[4],
            1.0,
        ];

        return candidates.find(scale => supports(scale)) ?? currentScale;
    }

    _chooseTransform(entries, currentTransform) {
        const saved = entries.find(entry =>
            entry.saved && hasOwn(entry.saved, 'transform'));
        const transform = saved && saved.saved.transform;

        return Number.isInteger(transform) && transform >= 0 && transform <= 7
            ? transform
            : currentTransform;
    }

    _applyPersistedConfig(configType, done, restoreGeneration) {
        const finish = () => {
            if (done)
                done();
        };
        const proxy = this._proxy;
        const generation = this._generation;

        if (!this._enabled || !proxy) {
            finish();
            return;
        }

        proxy.GetCurrentStateRemote((result, error) => {
            if (!this._enabled || proxy !== this._proxy ||
                generation !== this._generation ||
                restoreGeneration !== this._restoreGeneration || error || !result) {
                finish();
                return;
            }

            const [serial, monitors, logicalMonitors, properties] = result;
            if (!logicalMonitors.length) {
                finish();
                return;
            }

            const monitorMap = new Map(monitors.map(monitor => [
                monitor[0][0],
                monitor,
            ]));
            const restoreLayout = (
                configType === Meta.MonitorSwitchConfigType.ALL_LINEAR ||
                configType === Meta.MonitorSwitchConfigType.EXTERNAL
            ) && logicalMonitors.length > 1;
            const currentLayoutMode = unpack(properties?.['layout-mode']);
            const supportsLayoutMode = unpack(
                properties?.['supports-changing-layout-mode']
            ) === true;
            const savedLayoutMode = this._memory.layout_mode;
            const layoutMode = supportsLayoutMode && [1, 2].includes(savedLayoutMode)
                ? savedLayoutMode
                : currentLayoutMode;
            const globalScaleRequired = unpack(
                properties?.['global-scale-required']
            ) === true;
            const entries = [];
            let changed = layoutMode !== currentLayoutMode;

            for (const logicalMonitor of logicalMonitors) {
                const [x, y, scale, transform, primary, monitorSpecs] = logicalMonitor;
                const monitorEntries = [];
                const configuredMonitors = [];

                for (const monitorSpec of monitorSpecs) {
                    const connector = monitorSpec[0];
                    const saved = this._memory[connector];
                    const monitor = monitorMap.get(connector);
                    const profile = saved && typeof saved === 'object' &&
                        !Array.isArray(saved) && profileMatchesMonitor(saved, monitor?.[0])
                        ? saved
                        : null;
                    const currentMode = this._currentMode(monitor);
                    const currentModeId = currentMode ? currentMode[0] : '';
                    const savedModeId = profile && profile.mode_id;
                    const selectedModeId = savedModeId &&
                        this._modeForId(monitor, savedModeId, null)
                        ? savedModeId
                        : currentModeId;
                    const selectedMode = this._modeForId(
                        monitor,
                        selectedModeId,
                        currentMode
                    );

                    if (!selectedModeId) {
                        finish();
                        return;
                    }

                    if (selectedModeId !== currentModeId)
                        changed = true;

                    monitorEntries.push({
                        saved: profile,
                        selectedMode,
                    });
                    configuredMonitors.push([
                        connector,
                        selectedModeId,
                        monitorApplyProperties(monitor?.[2]),
                    ]);
                }

                let nextX = x;
                let nextY = y;
                let nextPrimary = primary;
                const savedLayout = monitorEntries.find(entry =>
                    restoreLayout && entry.saved &&
                    hasOwn(entry.saved, 'x') && hasOwn(entry.saved, 'y'));
                if (savedLayout) {
                    if (Number.isFinite(savedLayout.saved.x))
                        nextX = savedLayout.saved.x;
                    if (Number.isFinite(savedLayout.saved.y))
                        nextY = savedLayout.saved.y;
                    if (typeof savedLayout.saved.primary === 'boolean')
                        nextPrimary = savedLayout.saved.primary;
                }

                const nextScale = this._chooseScale(
                    monitorEntries,
                    scale,
                    layoutMode
                );
                const nextTransform = this._chooseTransform(monitorEntries, transform);
                if (Math.abs(nextScale - scale) >= 0.01 ||
                    nextTransform !== transform ||
                    nextX !== x || nextY !== y ||
                    nextPrimary !== primary)
                    changed = true;

                entries.push({
                    x: nextX,
                    y: nextY,
                    scale: nextScale,
                    transform: nextTransform,
                    primary: nextPrimary,
                    mode: monitorEntries[0].selectedMode,
                    modes: monitorEntries.map(entry => entry.selectedMode),
                    monitors: configuredMonitors,
                });
            }

            if (globalScaleRequired) {
                const candidates = [...entries.map(entry => entry.scale), 1.0];
                const globalScale = candidates.find(scale => entries.every(entry =>
                    entry.modes.every(mode =>
                        this._scaleSupported(mode, scale, layoutMode))));
                if (globalScale === undefined) {
                    finish();
                    return;
                }
                for (const entry of entries) {
                    if (Math.abs(entry.scale - globalScale) >= 0.01)
                        changed = true;
                    entry.scale = globalScale;
                }
            }

            const positions = normalizeLayout(entries, layoutMode);
            const primary = normalizePrimary(entries.map(entry => entry.primary));
            const newLogicalMonitors = entries.map((entry, index) => [
                positions[index].x,
                positions[index].y,
                entry.scale,
                entry.transform,
                primary[index],
                entry.monitors,
            ]);

            // Compare final positions and primary flags, including repairs.
            changed ||= newLogicalMonitors.some((lm, index) =>
                lm.slice(0, 5).some((value, field) => value !== logicalMonitors[index][field]));
            if (!changed) {
                finish();
                return;
            }

            const applyProperties = {};
            if (supportsLayoutMode && [1, 2].includes(layoutMode))
                applyProperties['layout-mode'] = new GLib.Variant('u', layoutMode);
            const monitorsForLease = monitors
                .filter(monitor => unpack(monitor[2]?.['is-for-lease']) === true)
                .map(monitor => monitor[0]);
            if (monitorsForLease.length > 0) {
                applyProperties['monitors-for-lease'] = new GLib.Variant(
                    'a(ssss)',
                    monitorsForLease
                );
            }

            const currentPrimaryConnector = primaryMonitorConnector(logicalMonitors);
            const targetPrimaryIndex = primary.findIndex(Boolean);
            const targetPrimaryLM = targetPrimaryIndex >= 0 ? newLogicalMonitors[targetPrimaryIndex] : null;
            const targetPrimaryConnector = targetPrimaryLM ? primaryMonitorConnector([targetPrimaryLM]) : null;

            const mustTransitionPrimary = newLogicalMonitors.length > 1 &&
                (hasMultiplePrimaries(logicalMonitors) ||
                 (currentPrimaryConnector && targetPrimaryConnector &&
                  currentPrimaryConnector !== targetPrimaryConnector));

            let transitioned = false;
            const recoveryFailed = error => {
                console.error('[PersistDisplays] Recovery error:', error);
                finish();
            };
            const recover = () => {
                // Do not overwrite a newer switch or a configuration after disable.
                if (!transitioned || !this._enabled || proxy !== this._proxy ||
                    generation !== this._generation ||
                    restoreGeneration !== this._restoreGeneration) {
                    finish();
                    return;
                }
                try {
                    proxy.GetCurrentStateRemote((state, error) => {
                        try {
                            if (error || !state || !this._enabled || proxy !== this._proxy ||
                                generation !== this._generation ||
                                restoreGeneration !== this._restoreGeneration) {
                                if (error)
                                    console.error('[PersistDisplays] Recovery state error:', error);
                                finish();
                                return;
                            }
                            const original = logicalMonitors.map(lm => [
                                ...lm.slice(0, 5),
                                lm[5].map(spec => {
                                    const monitor = monitorMap.get(spec[0]);
                                    return [spec[0], this._currentMode(monitor)[0],
                                        monitorApplyProperties(monitor?.[2])];
                                }),
                            ]);
                            const originalProperties = { ...applyProperties };
                            if (supportsLayoutMode && [1, 2].includes(currentLayoutMode))
                                originalProperties['layout-mode'] = new GLib.Variant('u', currentLayoutMode);
                            proxy.ApplyMonitorsConfigRemote(state[0], TEMPORARY_CONFIG,
                                original, originalProperties, (_result, recoveryError) => {
                                    if (recoveryError)
                                        console.error('[PersistDisplays] Recovery apply error:', recoveryError);
                                    finish();
                                });
                        } catch (e) {
                            recoveryFailed(e);
                        }
                    });
                } catch (e) {
                    recoveryFailed(e);
                }
            };

            const applyFullConfig = (configSerial) => {
                if (!this._enabled || proxy !== this._proxy ||
                    generation !== this._generation ||
                    restoreGeneration !== this._restoreGeneration) {
                    finish();
                    return;
                }
                try {
                    proxy.ApplyMonitorsConfigRemote(
                        configSerial,
                        TEMPORARY_CONFIG,
                        newLogicalMonitors,
                        applyProperties,
                        (_result, applyError) => {
                            if (applyError) {
                                console.error('[PersistDisplays] ApplyMonitorsConfig error:', applyError);
                                recover();
                            } else {
                                finish();
                            }
                        }
                    );
                } catch (e) {
                    console.error('[PersistDisplays] ApplyMonitorsConfig error:', e);
                    recover();
                }
            };

            if (mustTransitionPrimary && targetPrimaryLM) {
                // In Mutter 50 (upstream issue #4955), changing which monitor is primary
                // without destroying the previous primary's logical monitor leaves is_primary
                // set on both monitors, breaking workspace switching on secondary displays.
                // Transitioning through a single-monitor layout of the target primary forces
                // Mutter to cleanly reconstruct the non-primary logical monitors.
                const singlePrimaryLM = [
                    [0, 0, targetPrimaryLM[2], targetPrimaryLM[3], true, targetPrimaryLM[5]],
                ];
                try {
                    proxy.ApplyMonitorsConfigRemote(
                        serial,
                        TEMPORARY_CONFIG,
                        singlePrimaryLM,
                        applyProperties,
                        (_stepResult, stepError) => {
                            if (stepError) {
                                console.error('[PersistDisplays] Primary transition error:', stepError);
                                finish();
                                return;
                            }
                            if (!this._enabled || proxy !== this._proxy ||
                                generation !== this._generation ||
                                restoreGeneration !== this._restoreGeneration) {
                                finish();
                                return;
                            }
                            transitioned = true;
                            proxy.GetCurrentStateRemote((stateResult, stateError) => {
                                if (stateError || !stateResult ||
                                    !this._enabled || proxy !== this._proxy ||
                                    generation !== this._generation ||
                                    restoreGeneration !== this._restoreGeneration) {
                                    recover();
                                    return;
                                }
                                const [newSerial] = stateResult;
                                applyFullConfig(newSerial);
                            });
                        }
                    );
                } catch (e) {
                    console.error('[PersistDisplays] Primary transition apply error:', e);
                    finish();
                }
            } else {
                applyFullConfig(serial);
            }
        });
    }

    disable() {
        this._enabled = false;
        this._generation++;
        this._restoreGeneration++;
        this._snapshotGeneration++;

        for (const property of [
            '_switchTimeoutId',
            '_restoreSourceId',
            '_snapshotSourceId',
            '_ignoreSnapshotSourceId',
        ]) {
            if (this[property]) {
                GLib.source_remove(this[property]);
                this[property] = 0;
            }
        }

        const prototype = SwitchMonitor.SwitchMonitorPopup.prototype;
        if (prototype && prototype._finish === this._finishWrapper)
            prototype._finish = this._originalFinish;

        if (this._signalId && this._proxy) {
            this._proxy.disconnectSignal(this._signalId);
            this._signalId = null;
        }

        this._proxy = null;
        this._memory = null;
        this._restoreInFlight = false;
        this._pendingRestoreType = null;
        this._snapshotInFlight = false;
        this._snapshotAgain = false;
        this._suppressSnapshot = false;
        this._finishWrapper = null;
        this._originalFinish = null;
    }
}
