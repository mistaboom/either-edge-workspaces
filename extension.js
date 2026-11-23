// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceGroup} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

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

function overviewSwipeActive() {
    if (!Main.overview.visible)
        return false;
    const display = Main.overview._overview?.controls._workspacesDisplay;
    return display?._gestureActive && display.mapped;
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
        const tracker = Main.wm._workspaceTracker;
        this._hooks = new InjectionManager();
        this._hooks.overrideMethod(Object.getPrototypeOf(tracker), '_checkWorkspaces',
            original => () => this._check(tracker, original));
        this._hooks.overrideMethod(WorkspaceGroup.prototype, '_syncStacking',
            () => restackClones);
        this._reordered = global.workspace_manager.connect('workspaces-reordered',
            () => tracker._queueCheckWorkspaces());
        this._queueFreshCheck();
    }

    _check(tracker, original) {
        if (!Meta.prefs_get_dynamic_workspaces() || tracker._pauseWorkspaceCheck)
            return original.call(tracker);

        // Activities resolves its swipe destination by index, even on release.
        if (overviewSwipeActive())
            return GLib.SOURCE_CONTINUE;

        // The switcher snapshots its workspace list for the duration of a swipe.
        const group = Main.wm._workspaceAnimation?._switchData?.monitors[0];
        if (group) {
            if (!this._switchGroup) {
                this._switchGroup = group;
                this._switchDone = group.connect('destroy', () => {
                    this._switchGroup = null;
                    tracker._queueCheckWorkspaces();
                });
            }
            tracker._checkWorkspacesId = 0;
            return GLib.SOURCE_REMOVE;
        }

        let left = tracker._workspaces[0];
        const leftHasMembers = left.n_windows !== 0;
        const window = findWindow(left, leftHasMembers);
        if (!window) {
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

        if (leftHasMembers && window.get_workspace() === left) {
            const manager = global.workspace_manager;
            left = manager.append_new_workspace(false, global.get_current_time());
            manager.reorder_workspace(left, 0);
            // A reorder listener can stick or close the window that caused
            // the prepend. Recheck before treating the new edge as occupied.
            if (window.is_on_all_workspaces() || !window.get_compositor_private())
                return GLib.SOURCE_CONTINUE;
        } else if (left.active) {
            return original.call(tracker);
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

    _queueFreshCheck() {
        const tracker = Main.wm._workspaceTracker;
        const laters = global.compositor.get_laters();
        // Shell binds the method when it queues a check. Replace any stale callback.
        if (tracker._checkWorkspacesId) {
            laters.remove(tracker._checkWorkspacesId);
            tracker._checkWorkspacesId = 0;
        }
        tracker._queueCheckWorkspaces();
    }

    disable() {
        if (this._switchGroup) {
            this._switchGroup.disconnect(this._switchDone);
            this._switchGroup = null;
        }
        global.workspace_manager.disconnect(this._reordered);
        this._hooks.clear();
        const animation = Main.wm._workspaceAnimation;
        if (animation?._switchData || overviewSwipeActive()) {
            // Shell binds the callback in _queueCheckWorkspaces(). Let that one
            // native later wait just as it would for a paused check. This keeps
            // swipe targets alive through release, including the easing phase.
            // The bound callback retains only Shell objects, and a re-enable
            // can replace it by its normal later ID.
            const proto = Object.getPrototypeOf(Main.wm._workspaceTracker);
            this._hooks.overrideMethod(proto, '_checkWorkspaces', check => function () {
                if (animation?._switchData || overviewSwipeActive())
                    return GLib.SOURCE_CONTINUE;
                return check.call(this);
            });
        }
        try {
            this._queueFreshCheck();
        } finally {
            this._hooks.clear();
            this._hooks = null;
        }
    }
}
