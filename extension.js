import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as SwitchMonitor from 'resource:///org/gnome/shell/ui/switchMonitor.js';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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

let originalFinish = null;

function unpack(value) {
    return value && typeof value.unpack === 'function' ? value.unpack() : value;
}

function hasOwn(object, property) {
    return object && Object.prototype.hasOwnProperty.call(object, property);
}

export default class PersistDisplaysExtension extends Extension {
    enable() {
        this._enabled = true;
        this._configFile = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'persist-displays.json',
        ]);
        this._memory = this._loadMemory();
        this._suppressSnapshot = false;
        this._restoreSourceId = 0;

        this._proxy = null;
        new DisplayConfigProxy(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            (proxy, error) => {
                if (!this._enabled)
                    return;
                if (error) {
                    console.error('[PersistDisplays] Failed to connect to DisplayConfig:', error);
                    return;
                }

                this._proxy = proxy;
                this._signalId = proxy.connectSignal('MonitorsChanged', () => {
                    if (!this._suppressSnapshot)
                        this._snapshotActiveMonitors();
                });
                this._snapshotActiveMonitors();
            }
        );

        if (originalFinish === null)
            originalFinish = SwitchMonitor.SwitchMonitorPopup.prototype._finish;

        const extension = this;
        SwitchMonitor.SwitchMonitorPopup.prototype._finish = function () {
            const item = this._items[this._selectedIndex];
            const configType = item && item.configType;

            if (extension._shouldRestore(configType)) {
                // _finish() queues Mutter's switch_config() on an idle source.
                // Queue ours afterwards so it amends the configuration Mutter
                // just selected, rather than being overwritten by it.
                extension._suppressSnapshot = true;
                try {
                    originalFinish.call(this);
                } finally {
                    extension._queueRestore(configType);
                }
                return;
            }

            originalFinish.call(this);
        };
    }

    _shouldRestore(configType) {
        if (configType === undefined)
            return false;

        return configType === Meta.MonitorSwitchConfigType.ALL_LINEAR ||
            configType === Meta.MonitorSwitchConfigType.BUILTIN ||
            configType === Meta.MonitorSwitchConfigType.EXTERNAL;
    }

    _queueRestore(configType) {
        if (this._restoreSourceId)
            GLib.source_remove(this._restoreSourceId);

        this._restoreSourceId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._restoreSourceId = 0;
            this._applyPersistedConfig(configType, () => {
                this._suppressSnapshot = false;
            });
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
            const data = new TextEncoder().encode(JSON.stringify(this._memory, null, 2));
            GLib.file_set_contents(this._configFile, data);
        } catch (e) {
            console.error('[PersistDisplays] Failed to save memory:', e);
        }
    }

    _snapshotActiveMonitors() {
        const proxy = this._proxy;
        if (!this._enabled || !proxy || this._suppressSnapshot)
            return;

        proxy.GetCurrentStateRemote((result, error) => {
            if (!this._enabled || proxy !== this._proxy ||
                this._suppressSnapshot || error || !result)
                return;

            const [, monitors, logicalMonitors] = result;
            const monitorMap = new Map(monitors.map(monitor => [
                monitor[0][0],
                monitor,
            ]));

            for (const logicalMonitor of logicalMonitors) {
                const [x, y, scale, transform, primary, monitorSpecs] = logicalMonitor;

                for (const monitorSpec of monitorSpecs) {
                    const connector = monitorSpec[0];
                    const existing = this._memory[connector];
                    const profile = existing && typeof existing === 'object' &&
                        !Array.isArray(existing) ? existing : {};

                    profile.scale = scale;
                    profile.transform = transform;

                    const monitor = monitorMap.get(connector);
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

    _scaleSupported(mode, scale) {
        if (!Number.isFinite(scale) || scale <= 0)
            return false;

        const supportedScales = mode && unpack(mode[5]);
        if (!supportedScales || supportedScales.length === 0)
            return true;

        return supportedScales.some(value => Math.abs(value - scale) < 0.01);
    }

    _chooseScale(entries, currentScale) {
        const supports = scale => entries.every(entry =>
            this._scaleSupported(entry.selectedMode, scale));
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

    _applyPersistedConfig(configType, done) {
        const finish = () => {
            if (done)
                done();
        };
        const proxy = this._proxy;

        if (!this._enabled || !proxy) {
            finish();
            return;
        }

        proxy.GetCurrentStateRemote((result, error) => {
            if (!this._enabled || proxy !== this._proxy || error || !result) {
                finish();
                return;
            }

            const [serial, monitors, logicalMonitors] = result;
            if (!logicalMonitors.length) {
                finish();
                return;
            }

            const monitorMap = new Map(monitors.map(monitor => [
                monitor[0][0],
                monitor,
            ]));
            const restoreLayout = configType === Meta.MonitorSwitchConfigType.ALL_LINEAR &&
                logicalMonitors.length > 1;
            const entries = [];
            let changed = false;

            for (const logicalMonitor of logicalMonitors) {
                const [x, y, scale, transform, primary, monitorSpecs] = logicalMonitor;
                const monitorEntries = [];
                const configuredMonitors = [];

                for (const monitorSpec of monitorSpecs) {
                    const connector = monitorSpec[0];
                    const saved = this._memory[connector];
                    const profile = saved && typeof saved === 'object' &&
                        !Array.isArray(saved) ? saved : null;
                    const monitor = monitorMap.get(connector);
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
                    configuredMonitors.push([connector, selectedModeId, {}]);
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

                const nextScale = this._chooseScale(monitorEntries, scale);
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
                    monitors: configuredMonitors,
                });
            }

            if (!changed) {
                finish();
                return;
            }

            const minX = Math.min(...entries.map(entry => entry.x));
            const minY = Math.min(...entries.map(entry => entry.y));
            const hasPrimary = entries.some(entry => entry.primary);
            const newLogicalMonitors = entries.map((entry, index) => [
                entry.x - minX,
                entry.y - minY,
                entry.scale,
                entry.transform,
                hasPrimary ? entry.primary : index === 0,
                entry.monitors,
            ]);

            try {
                proxy.ApplyMonitorsConfigRemote(
                    serial,
                    TEMPORARY_CONFIG,
                    newLogicalMonitors,
                    {},
                    (_result, applyError) => {
                        if (applyError)
                            console.error('[PersistDisplays] ApplyMonitorsConfig error:', applyError);
                        finish();
                    }
                );
            } catch (e) {
                console.error('[PersistDisplays] ApplyMonitorsConfig error:', e);
                finish();
            }
        });
    }

    disable() {
        this._enabled = false;

        if (this._restoreSourceId) {
            GLib.source_remove(this._restoreSourceId);
            this._restoreSourceId = 0;
        }

        if (originalFinish) {
            SwitchMonitor.SwitchMonitorPopup.prototype._finish = originalFinish;
            originalFinish = null;
        }

        if (this._signalId && this._proxy) {
            this._proxy.disconnectSignal(this._signalId);
            this._signalId = null;
        }

        this._proxy = null;
        this._suppressSnapshot = false;
    }
}
