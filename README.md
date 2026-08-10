# Persist Displays

Persist Displays remembers monitor modes, scale, rotation, and layout when you use GNOME's `Super+P` display switcher. It currently supports GNOME Shell 50.

GNOME rebuilds the layout when the switcher changes modes. This extension records the current settings and reapplies them after Mutter switches the layout. It has no panel UI.

## Files

- `extension.js` contains the GNOME Shell integration.
- `logic.js` contains independently testable configuration helpers.
- `metadata.json` contains the GNOME Shell metadata.

## Install from a checkout

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/
ln -s ~/Projects/persist-displays ~/.local/share/gnome-shell/extensions/persist-displays@bukutsu.github.io
gnome-extensions enable persist-displays@bukutsu.github.io
```

Log out and back in after creating the symlink so GNOME Shell finds the extension.

## Test

```bash
gjs -m tests/logic.test.js
```

## Package

```bash
gnome-extensions pack --extra-source=logic.js --extra-source=LICENSE .
```
