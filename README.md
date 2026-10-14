# Persist Displays

Persist Displays keeps monitor modes, scale, rotation, and layout when you switch displays with GNOME's `Super+P` menu. GNOME Shell rebuilds the layout when you select a mode, so the extension saves the current display settings and reapplies them after the switch. It has no panel UI.

This works around [Mutter issue #326: switching display modes resets configuration](https://gitlab.gnome.org/GNOME/mutter/-/work_items/326). It restores saved settings when returning to an extended layout or selecting a single display, while leaving mirror mode to GNOME.

The extension supports GNOME Shell 50 and 51.

## Install

From the project directory, build and install the extension package:

```sh
gnome-extensions pack --force --extra-source=logic.js --extra-source=LICENSE .
gnome-extensions install --force persist-displays@bukutsu.github.io.shell-extension.zip
```

Log out and back in, then enable the extension:

```sh
gnome-extensions enable persist-displays@bukutsu.github.io
```

To update an existing installation, repeat the package and install commands, then restart GNOME Shell by logging out and back in. On Wayland, logging out is required; on X11, you can restart Shell with `Alt+F2`, then `r`.

## Test

Run the tests from the project directory:

```sh
gjs -m tests/logic.test.js
gjs -m tests/extension.test.js
```
