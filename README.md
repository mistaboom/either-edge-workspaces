# Streamlined Workspaces

Launch apps where you choose. Swipe to an empty workspace to open Activities.

A GNOME Shell 48 extension that keeps an empty workspace to the left of your windows. GNOME supplies the empty workspace on the right. Tested on GNOME Shell 48.7 with Wayland.

On a fresh login with dynamic workspaces, GNOME opens the Activities Overview on one empty workspace. The desktop preview shrinks and the Dash shows your favorite apps, just like one three-finger swipe up. If GNOME rearranges the displays during login, the extension restores that view on the primary display when the empty session is ready. A swipe in either direction stays there. Launch an app from Activities and an empty workspace appears on each side while the app starts. You can swipe away and launch another app. Each new window opens on the workspace where you launched it when GNOME can identify its launch. An outward swipe stops at an empty edge. Launch an app there and a new empty workspace appears beyond it.

If you close the last window between two occupied workspaces, the empty workspace stays selected until you leave. Once all windows are closed and no launches are pending, only the selected workspace remains. Fixed-workspace mode uses GNOME’s normal layout.

The top-left indicator shows GNOME’s stretched pill for the workspace you’re viewing. As you swipe toward an empty workspace, its marker grows into a pill while the old pill shrinks. Reverse the swipe and both markers follow your fingers back. When you leave an empty workspace, its marker shrinks away. Open a window there and its dot stays visible when you switch away. With dynamic workspaces, the dot also stays while an app you launched there is starting. Windows pinned to all workspaces don’t count toward these dots.

GNOME Shell launchers share the same placement logic across apps. For example, drag an app icon onto a workspace thumbnail in Activities to launch it there. The extension remembers each launch workspace for up to 60 seconds, even if its number changes. When it matches a new window to its launch, it also prevents a late Wayland activation token from switching you back after you leave. If two requests for the same running app target different workspaces and their windows have no token or process ID that distinguishes them, GNOME handles their placement.

On the desktop with dynamic workspaces, a completed three-finger touchpad swipe to a different empty workspace opens Activities, just like one swipe up. GNOME finishes the workspace switch first. If a window lands there during the swipe animation, you stay on the desktop. With workspaces on all displays, both animated and instantaneous switches finish on the native destination. If workspaces are on the primary display only and you change which display is primary during a swipe, you stay on the workspace where you started. If you have already lifted your fingers, GNOME finishes the switch.

With Quick Settings (including an expanded tile) or the calendar open, start a three-finger touchpad swipe to close the menu. The same swipe continues through GNOME, so you can switch workspaces in one motion.

During a workspace swipe, existing window previews follow changes in stacking order. New windows appear when the switch finishes. Workspace cleanup waits until the desktop or Activities swipe finishes so that the workspace list stays stable during the gesture.

## Install

Download `either-edge-workspaces@local.shell-extension.zip` from the [latest release](https://github.com/mistaboom/streamlined-workspaces/releases/latest). Run the following command from the directory containing the download.

```sh
gnome-extensions install --force ./either-edge-workspaces@local.shell-extension.zip
```

On Wayland, log out and sign back in so GNOME Shell loads the new code. On a first installation, enable it in the Extensions app or run the following command.

```sh
gnome-extensions enable either-edge-workspaces@local
```

## Use your saved displays and account at login on Debian 13

From this source checkout, run the command below in a terminal from the desktop account whose layouts GDM should follow. It installs or updates Streamlined Workspaces for the login screen and enables synchronization of that account’s saved GNOME display layouts.

```sh
sudo ./gdm/install
```

Use **Settings → Displays**, choose your primary screen or turn off a screen, then select **Apply → Keep Changes**. Each saved layout is copied to GDM, including its primary display, disabled screens and scale. The next login screen uses the layout for the connected hardware. Configure each new monitor setup once in Displays. The installer enables fractional scaling for the greeter and saves a first-install backup of an existing greeter layout.

At a fresh login screen with one eligible account, Streamlined Workspaces selects the account and lets GDM ask for the password or other configured authentication. Press Escape to return to the chooser. If multiple accounts are listed, choose one as usual. Timed login and authentication methods that determine the account themselves continue through GDM.

The installer also turns off GDM’s routine confirmation countdown for **Restart** and **Power Off**. GNOME can still show a prompt when something is blocking the action.

## Build from source

From the repository root, run the following command. It writes the same installable zip format to the current directory.

```sh
gnome-extensions pack --force --extra-source=COPYING --extra-source=launches.js --extra-source=greeter.js .
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
