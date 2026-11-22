# Either Edge Workspaces

A GNOME Shell 48 extension that keeps an empty workspace to the left of your windows. GNOME supplies the empty workspace on the right. Tested on GNOME Shell 48.7 with Wayland.

On a fresh login with dynamic workspaces, Activities opens on the middle of three empty workspaces. Swipe either way to get started. An outward swipe stops at an empty edge. Open a window there and a new empty workspace appears beyond it.

If you close the last window between two occupied workspaces, the empty workspace stays selected until you leave. Once all windows are closed, GNOME returns to its usual two workspaces. Fixed-workspace mode uses GNOME’s normal layout.

## Install

Download `either-edge-workspaces@local.shell-extension.zip` from the [latest release](https://github.com/mistaboom/either-edge-workspaces/releases/latest). Run the following command from the directory containing the download.

```sh
gnome-extensions install --force ./either-edge-workspaces@local.shell-extension.zip
```

On Wayland, log out and sign back in so GNOME Shell loads the new code. On a first installation, enable it in the Extensions app or run the following command.

```sh
gnome-extensions enable either-edge-workspaces@local
```

## Build from source

From the repository root, run the following command. It writes the same installable zip format to the current directory.

```sh
gnome-extensions pack --extra-source=COPYING .
```

## Check a swipe

With dynamic workspaces enabled, open two overlapping windows on the same workspace. Start and hold a desktop swipe. While it is held, have another window open on that workspace and raise one of the original windows. The original window previews should restack in the same order as their windows. A newly opened window appears when the swipe finishes.

Repeat with the extension disabled during the swipe. Finish the gesture, check the workspace you landed on, then re-enable the extension. To inspect Shell errors from this test, run the following command.

```sh
journalctl --user -b _COMM=gnome-shell --since '5 minutes ago'
```

Shell 48.7 builds the swipe from a snapshot of window clones. The extension follows GNOME’s approach of restacking only clones that belong to the snapshot, including separate handling for desktop backgrounds in the 48 implementation. [Upstream GNOME Shell fix](https://github.com/GNOME/gnome-shell/commit/e7e6de300cfb87c0f91738861b545017e5290ef9)

## License

GPL-2.0-or-later. See [COPYING](COPYING).
