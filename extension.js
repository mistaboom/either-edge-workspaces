// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceGroup} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

// These are properties of Shell's live window actors. Workspace membership
// alone can include a window before it has an actor, or while it is closing.
const NO_WINDOWS = 0;
const OTHER_WORKSPACE = 1;
const LEFT_WORKSPACE = 2;

function windowLocation(left, leftHasMembers) {
    if (!leftHasMembers) {
        const focus = global.display.focus_window;
        if (focus && !focus.is_on_all_workspaces() &&
            focus.get_compositor_private()?.is_destroyed() === false)
            return OTHER_WORKSPACE;
    }

    let location = NO_WINDOWS;
    for (const actor of global.get_window_actors()) {
        const window = actor.get_meta_window();
        if (window.is_on_all_workspaces())
            continue;
        if (!leftHasMembers)
            return OTHER_WORKSPACE;
        if (window.get_workspace() === left)
            return LEFT_WORKSPACE;
        location = OTHER_WORKSPACE;
    }
    return location;
}

// The 48.7 tracker treats a recently removed splash window as occupied.
// Lend it that predicate only for its synchronous check. A real removal
// during the check replaces the marker and must survive cleanup.
const protectedWorkspace = {get_window_type: () => Meta.WindowType.SPLASHSCREEN};

function protect(workspace) {
    const previous = workspace._lastRemovedWindow;
    workspace._lastRemovedWindow = protectedWorkspace;
    return previous;
}

function restore(workspace, previous) {
    if (workspace._lastRemovedWindow === protectedWorkspace)
        workspace._lastRemovedWindow = previous;
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
        // Remember the actual workspace, not its index: prepending the left
        // landing space keeps this desktop and its overview card selected.
        if (this._loginWorkspace === undefined)
            this._loginWorkspace = global.workspace_manager.get_active_workspace();
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
        const dynamic = Meta.prefs_get_dynamic_workspaces();
        if (!dynamic)
            this._loginWorkspace = null;
        if (!dynamic || tracker._pauseWorkspaceCheck)
            return original.call(tracker);

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
        // Once login protection ends, Shell already keeps an active blank left
        // edge. Its right-hand blank is determined by the occupied workspaces.
        if (!leftHasMembers && !this._loginWorkspace && left.active)
            return original.call(tracker);

        const location = windowLocation(left, leftHasMembers);
        if (this._loginWorkspace && (location !== NO_WINDOWS ||
            !tracker._workspaces.includes(this._loginWorkspace)))
            this._loginWorkspace = null;

        if (location === NO_WINDOWS && !this._loginWorkspace)
            return original.call(tracker);

        if (location === LEFT_WORKSPACE || left === this._loginWorkspace) {
            const manager = global.workspace_manager;
            left = manager.append_new_workspace(false, global.get_current_time());
            manager.reorder_workspace(left, 0);
        }

        const login = this._loginWorkspace;
        const previousLeft = protect(left);
        try {
            if (!login)
                return original.call(tracker);

            const previousLogin = protect(login);
            try {
                return original.call(tracker);
            } finally {
                restore(login, previousLogin);
            }
        } finally {
            restore(left, previousLeft);
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
        this._loginWorkspace = null;
        if (this._switchGroup) {
            this._switchGroup.disconnect(this._switchDone);
            this._switchGroup = null;
        }
        global.workspace_manager.disconnect(this._reordered);
        this._hooks.clear();
        const animation = Main.wm._workspaceAnimation;
        if (animation?._switchData) {
            // Shell binds the callback in _queueCheckWorkspaces(). Let that one
            // native later wait just as it would for a paused check. This keeps
            // swipe targets alive through release, including the easing phase.
            // The bound callback retains only Shell objects, and a re-enable
            // can replace it by its normal later ID.
            const proto = Object.getPrototypeOf(Main.wm._workspaceTracker);
            this._hooks.overrideMethod(proto, '_checkWorkspaces', check => function () {
                if (animation._switchData)
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
