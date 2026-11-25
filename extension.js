// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {TransientSignalHolder} from 'resource:///org/gnome/shell/misc/signalTracker.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {MonitorGroup, WorkspaceGroup} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import {WorkspacesDisplay} from 'resource:///org/gnome/shell/ui/workspacesView.js';

import {watchLoginChooser} from './greeter.js';
import {WorkspaceLaunches} from './launches.js';

// Prefer a window on the left edge. Workspace membership alone can include
// a window before it has a compositor actor, or while it is closing.
function findWindow(left, leftHasMembers) {
    if (!leftHasMembers) {
        const focus = global.display.focus_window;
        if (focus && !focus.is_on_all_workspaces() &&
            focus.get_compositor_private()?.is_destroyed() === false)
            return focus;
    }

    let otherWindow = null;
    for (const actor of global.get_window_actors()) {
        const window = actor.get_meta_window();
        if (window.is_on_all_workspaces())
            continue;
        if (!leftHasMembers || window.get_workspace() === left)
            return window;
        otherWindow = window;
    }
    return otherWindow;
}

// The 48.7 tracker treats a recently removed splash window as occupied.
// Lend it that predicate only for its synchronous check. A real removal
// during the check replaces the marker and must survive cleanup.
const protectedWorkspace = {get_window_type: () => Meta.WindowType.SPLASHSCREEN};

function onPanelMenuGesture(menu, actor, event) {
    if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE ||
        event.get_gesture_phase() !== Clutter.TouchpadGesturePhase.BEGIN ||
        event.get_touchpad_gesture_finger_count() !== 3 ||
        global.stage.get_grab_actor() !== actor || !menu.isOpen ||
        (actor !== menu.actor && actor !== menu._activeMenu?.actor))
        return Clutter.EVENT_PROPAGATE;

    // BEGIN's capture path already starts at the popup grab. Release it and
    // give GNOME the same BEGIN it would receive with the menus closed.
    menu.close(PopupAnimation.FULL);
    const grab = global.stage.get_grab_actor();
    if (!grab || grab === global.stage)
        global.stage.event(event, true);
    return Clutter.EVENT_STOP;
}

function watchPanelMenus(holder) {
    const {dateMenu, quickSettings} = Main.panel.statusArea;
    const quickMenu = quickSettings?.menu;
    const watch = (menu, actor) => actor.connectObject(
        'captured-event::touchpad', onPanelMenuGesture.bind(null, menu), holder);

    for (const menu of [dateMenu?.menu, quickMenu]) {
        if (menu)
            watch(menu, menu.actor);
    }

    // Expanded tiles grab their own actors. Shell adds those actors to the
    // overlay, including tiles added after the extension is enabled.
    const overlay = quickMenu?._overlay;
    if (overlay) {
        for (const actor of overlay.get_children())
            watch(quickMenu, actor);
        overlay.connectObject(
            'child-added', (_overlay, actor) => watch(quickMenu, actor),
            'child-removed', (_overlay, actor) => actor.disconnectObject(holder), holder);
    }
}

function overviewSwipeActive() {
    if (!Main.overview.visible)
        return false;
    const display = Main.overview._overview?.controls._workspacesDisplay;
    return display?._gestureActive && display.mapped;
}

function workspaceIsEmpty(workspace) {
    return workspace.list_windows().every(window => window.is_on_all_workspaces());
}

function restoreLoginOverview(launches, holder) {
    const {layoutManager, overview} = Main;
    if (!layoutManager._startingUp || Meta.is_restart())
        return;

    // A monitor relayout hides the native window picker, even during login.
    const startup = new TransientSignalHolder(holder);
    let layoutChanged = false;
    layoutManager.connectObject(
        'monitors-changed', () => { layoutChanged = true; },
        'startup-complete', () => {
            startup.destroy();
            if (layoutChanged && !overview.visibleTarget && Main.actionMode === Shell.ActionMode.NORMAL &&
                Meta.prefs_get_dynamic_workspaces() && !launches.pending.size &&
                workspaceIsEmpty(global.workspace_manager.get_active_workspace()))
                overview.show();
        }, startup);
}

// 48.7 resolves a workspace object at gesture begin and again at release.
// Observe the native choice before even a zero-duration snap can activate it.
function watchWorkspaceSwitches(hooks, resumeCheck, holder) {
    const animation = Main.wm._workspaceAnimation;
    const controller = Object.getPrototypeOf(animation);
    let landing = null;
    const syncMonitorGroups = () => {
        const data = animation._switchData;
        if (!data)
            return;

        const {monitors} = data;
        const primary = Main.layoutManager.primaryIndex;
        if (monitors.at(-1)?.index === primary)
            return;

        // The primary's completion destroys every group. Ease that group last.
        const index = monitors.findIndex(group => group.index === primary);
        if (index >= 0) {
            monitors.push(monitors.splice(index, 1)[0]);
        } else if (monitors.length === 1 && data.baseMonitorGroup &&
            Meta.prefs_get_workspaces_only_on_primary() && !data.baseMonitorGroup.get_transition('progress')) {
            // A held swipe on the former primary cannot finish this snapshot.
            // An already-released swipe still has its native completion callback.
            landing = null;
            animation._finishWorkspaceSwitch(data);
        }
    };
    syncMonitorGroups();
    Main.layoutManager.connectObject('monitors-changed', syncMonitorGroups, holder);
    hooks.overrideMethod(controller, '_prepareWorkspaceSwitch', original =>
        function (indices) {
            original.call(this, indices);
            if (this._switchData?.monitors.length > 1)
                syncMonitorGroups();
        });
    hooks.overrideMethod(MonitorGroup.prototype, 'findClosestWorkspace', original =>
        function (progress) {
            const target = original.call(this, progress);
            const event = Clutter.get_current_event();
            landing = null;
            if (!target.active && this === animation._switchData?.baseMonitorGroup &&
                event?.type() === Clutter.EventType.TOUCHPAD_SWIPE &&
                event.get_gesture_phase() === Clutter.TouchpadGesturePhase.END &&
                event.get_touchpad_gesture_finger_count() === 3)
                landing = target;
            return target;
        });
    hooks.overrideMethod(controller, '_finishWorkspaceSwitch', original =>
        function (switchData) {
            const target = landing;
            landing = null;
            original.call(this, switchData);
            resumeCheck();
            // Check at landing: a slow app may have opened during the snap.
            if (target?.active && Main.actionMode === Shell.ActionMode.NORMAL &&
                !Main.overview.visible && Meta.prefs_get_dynamic_workspaces() &&
                workspaceIsEmpty(target))
                Main.overview.show();
        });
}

function hasWorkspaceReservation(workspaces) {
    for (const workspace of workspaces) {
        if (workspace._keepAliveId)
            return true;
        const type = workspace._lastRemovedWindow?.get_window_type();
        if (type === Meta.WindowType.SPLASHSCREEN || type === Meta.WindowType.DIALOG ||
            type === Meta.WindowType.MODAL_DIALOG)
            return true;
    }

    return Shell.WindowTracker.get_default().get_startup_sequences().some(sequence => {
        const index = sequence.get_workspace();
        return index >= 0 && index <= workspaces.length;
    });
}

// A 48.x animation owns a snapshot of clones. A restack can include actors
// that mapped later, and desktop clones belong to the background instead.
function restackClones() {
    if (this._windowRecords.length === 0)
        return;

    let sibling = this._background ?? null;
    for (const actor of global.get_window_actors()) {
        const record = this._windowRecords.find(r => r.windowActor === actor);
        if (!record || record.clone.get_parent() !== this ||
            !this._shouldShowWindow(actor.meta_window))
            continue;

        this.set_child_above_sibling(record.clone, sibling);
        sibling = record.clone;
    }
}

export default class EitherEdgeWorkspaces extends Extension {
    enable() {
        if (Main.sessionMode.isGreeter) {
            this._stopWatchingLogin = watchLoginChooser();
            return;
        }

        const tracker = Main.wm._workspaceTracker;
        this._hooks = new InjectionManager();
        this._launches = new WorkspaceLaunches(this._hooks, () => tracker._queueCheckWorkspaces());
        this._hooks.overrideMethod(Object.getPrototypeOf(tracker), '_checkWorkspaces',
            original => () => this._check(tracker, original));
        this._hooks.overrideMethod(WorkspaceGroup.prototype, '_syncStacking',
            () => restackClones);
        this._reordered = global.workspace_manager.connect('workspaces-reordered',
            () => tracker._queueCheckWorkspaces());
        this._signals = new TransientSignalHolder();
        watchPanelMenus(this._signals);
        restoreLoginOverview(this._launches, this._signals);

        const resumeCheck = () => {
            if (this._deferredCheck) {
                this._deferredCheck = false;
                tracker._queueCheckWorkspaces();
            }
        };
        watchWorkspaceSwitches(this._hooks, resumeCheck, this._signals);
        this._hooks.overrideMethod(WorkspacesDisplay.prototype, '_endTouchGesture', original =>
            function () {
                original.call(this);
                resumeCheck();
            });
        Main.overview._overview?.controls._workspacesDisplay.connectObject(
            'notify::mapped', resumeCheck, this._signals);
        this._queueFreshCheck();
    }

    _check(tracker, original) {
        if (!Meta.prefs_get_dynamic_workspaces()) {
            this._launches.clear();
            return original.call(tracker);
        }
        if (tracker._pauseWorkspaceCheck)
            return original.call(tracker);

        // Both switchers own a snapshot through release and easing. Their
        // completion callbacks (or an unmap in Activities) resume a pending check.
        if (overviewSwipeActive() || Main.wm._workspaceAnimation?._switchData?.monitors[0]) {
            this._deferredCheck = true;
            tracker._checkWorkspacesId = 0;
            return GLib.SOURCE_REMOVE;
        }

        let left = tracker._workspaces[0];
        const leftHasMembers = left.n_windows !== 0;
        const pending = this._launches.pending;
        let reserved = null;
        if (pending.size) {
            reserved = new Map();
            for (const {workspace} of pending)
                reserved.set(workspace, null);
        }
        const leftReserved = reserved?.has(left);
        const window = leftReserved || (reserved && !leftHasMembers)
            ? null : findWindow(left, leftHasMembers);
        if (!window && !reserved) {
            if (hasWorkspaceReservation(tracker._workspaces))
                return original.call(tracker);

            // Shell 48 enforces a minimum of two. Reuse the pending redraw
            // check after each removal so synchronous workspace-change listeners
            // can activate, populate or reserve a remaining workspace.
            if (tracker._workspaces.length > 1) {
                const last = tracker._workspaces.at(-1);
                const unused = last.active ? tracker._workspaces.at(-2) : last;
                global.workspace_manager.remove_workspace(unused, global.get_current_time());
                return GLib.SOURCE_CONTINUE;
            }
            tracker._checkWorkspacesId = 0;
            return GLib.SOURCE_REMOVE;
        }

        if (leftReserved || (leftHasMembers && window?.get_workspace() === left)) {
            const manager = global.workspace_manager;
            left = manager.append_new_workspace(false, global.get_current_time());
            manager.reorder_workspace(left, 0);
            // A reorder listener can stick or close the window that caused
            // the prepend. Recheck before treating the new edge as occupied.
            if (window && (window.is_on_all_workspaces() || !window.get_compositor_private()))
                return GLib.SOURCE_CONTINUE;
        } else if (!reserved && left.active) {
            return original.call(tracker);
        }

        if (reserved) {
            // Shell already scans real windows and protects the active workspace.
            // Let it see launches as occupied in that same synchronous check.
            reserved.set(left, null);
            for (const workspace of reserved.keys()) {
                // A reorder listener may have changed the marker.
                reserved.set(workspace, workspace._lastRemovedWindow);
                workspace._lastRemovedWindow = protectedWorkspace;
            }
            try {
                return original.call(tracker);
            } finally {
                for (const [workspace, previous] of reserved) {
                    if (workspace._lastRemovedWindow === protectedWorkspace)
                        workspace._lastRemovedWindow = previous;
                }
            }
        }

        const previous = left._lastRemovedWindow;
        left._lastRemovedWindow = protectedWorkspace;
        try {
            return original.call(tracker);
        } finally {
            if (left._lastRemovedWindow === protectedWorkspace)
                left._lastRemovedWindow = previous;
        }
    }

    _queueFreshCheck(disabling = false) {
        const tracker = Main.wm._workspaceTracker;
        const laters = global.compositor.get_laters();
        // Shell binds the method when it queues a check. Replace any stale callback.
        if (tracker._checkWorkspacesId) {
            laters.remove(tracker._checkWorkspacesId);
            tracker._checkWorkspacesId = 0;
        }
        if (disabling) {
            const animation = Main.wm._workspaceAnimation;
            const switching = () => animation?._switchData || overviewSwipeActive();
            if (switching()) {
                // Keep Shell's one pending later through release and easing.
                // Re-enabling can replace it using the same tracker-owned ID.
                const check = tracker._checkWorkspaces.bind(tracker);
                tracker._checkWorkspacesId = laters.add(Meta.LaterType.BEFORE_REDRAW,
                    () => switching() ? GLib.SOURCE_CONTINUE : check());
                return;
            }
        }
        tracker._queueCheckWorkspaces();
    }

    disable() {
        if (this._stopWatchingLogin) {
            this._stopWatchingLogin();
            this._stopWatchingLogin = null;
            return;
        }

        this._signals.destroy();
        this._signals = null;
        this._deferredCheck = false;
        this._launches.destroy();
        this._launches = null;
        global.workspace_manager.disconnect(this._reordered);
        this._hooks.clear();
        this._hooks = null;
        this._queueFreshCheck(true);
    }
}
