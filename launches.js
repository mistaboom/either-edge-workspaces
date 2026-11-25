// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

// Some desktop actions never open a window. Bound their reservations without
// polling slow apps or depending on a startup sequence lasting until first map.
const LAUNCH_TIMEOUT_SECONDS = 60;

function startupId(data) {
    return data?.lookup_value('startup-notification-id', null)?.get_string()[0];
}

export class WorkspaceLaunches {
    constructor(hooks, queueCheck) {
        this._queueCheck = queueCheck;
        this.pending = new Set();
        this._windows = new Map();
        this._contexts = new WeakMap();
        this._activations = new Map();
        this._tracker = Shell.WindowTracker.get_default();

        // Both Shell's C launchers and its JavaScript launchers use GIO. This
        // fires before spawn, even for desktop files with StartupNotify=false.
        this._signal = GObject.signal_lookup('launch-started', Gio.AppLaunchContext);
        this._hook = GObject.signal_add_emission_hook(this._signal, 0, (_hint, [context, info, data]) => {
            if (context instanceof Meta.LaunchContext && Meta.prefs_get_dynamic_workspaces()) {
                const intent = this._intent?.appId === info.get_id() ? this._intent : null;
                const target = intent?.workspace ?? this._contexts.get(context) ??
                    context.workspace ?? global.workspace_manager.get_active_workspace();
                this._reserve(target, info.get_id(), context, startupId(data));
                if (intent)
                    intent.started = true;
            }
            return true;
        });

        // An explicit numeric hint is baked into Mutter's activation token.
        // Remember the object instead, so a prepend cannot retarget a late
        // token. A -1 hint leaves native activation timestamp handling intact.
        const contexts = this._contexts;
        hooks.overrideMethod(Shell.Global.prototype, 'create_app_launch_context', original =>
            function (timestamp, index) {
                if (index < 0 || !Meta.prefs_get_dynamic_workspaces())
                    return original.call(this, timestamp, index);
                const workspace = this.workspace_manager.get_workspace_by_index(index);
                const context = original.call(this, timestamp, workspace ? -1 : index);
                if (workspace)
                    contexts.set(context, workspace);
                return context;
            });

        // Direct D-Bus new-window and desktop actions can bypass GIO signals.
        // The scope also carries explicit targets through Shell's C methods.
        this._wrap(hooks, 'open_new_window', 0, true);
        this._wrap(hooks, 'launch_action', 2, true);
        this._wrap(hooks, 'launch', 1, false);
        this._wrap(hooks, 'activate_full', 0, false);
        this._wrap(hooks, 'activate_action', 3, true);

        // Some Shell menus call GDesktopAppInfo directly (e.g. Calendar).
        const launches = this;
        hooks.overrideMethod(Gio.DesktopAppInfo.prototype, 'launch_action', original =>
            function (action, context) {
                if (!(context instanceof Meta.LaunchContext) || !Meta.prefs_get_dynamic_workspaces())
                    return original.call(this, action, context);
                const workspace = contexts.get(context) ?? context.workspace ??
                    global.workspace_manager.get_active_workspace();
                return launches._dispatch(this.get_id(), workspace, true,
                    () => original.call(this, action, context));
            });
    }

    _wrap(hooks, method, indexArg, allowDirect) {
        const launches = this;
        hooks.overrideMethod(Shell.App.prototype, method, original => function (...args) {
            const index = args[indexArg];
            if ((!allowDirect && index < 0) || !this.get_app_info() ||
                !Meta.prefs_get_dynamic_workspaces() ||
                (method === 'activate_full' && this.state !== Shell.AppState.STOPPED) ||
                (method === 'activate_action' && this.state !== Shell.AppState.STOPPED &&
                    args[0] !== 'new-window'))
                return original.apply(this, args);

            const manager = global.workspace_manager;
            const workspace = index < 0 ? manager.get_active_workspace() : manager.get_workspace_by_index(index);
            if (!workspace)
                return original.apply(this, args);

            args[indexArg] = -1;
            return launches._dispatch(this.get_id(), workspace, allowDirect,
                () => original.apply(this, args));
        });
    }

    _dispatch(appId, workspace, allowDirect, dispatch) {
        const intent = {workspace, appId, started: false};
        const previous = this._intent;
        this._intent = intent;
        // Direct D-Bus actions issue a token inside the native call, without
        // emitting GIO's launch-started signal.
        const watch = allowDirect ? this._tracker.connect('startup-sequence-changed',
            (_tracker, sequence) => {
                if (this._intent === intent && !sequence.get_completed())
                    intent.token = sequence.get_id();
            }) : 0;
        try {
            const result = dispatch();
            if (allowDirect && !intent.started) {
                const request = this._reserve(workspace, appId, null, intent.token);
                if (request && result instanceof Promise)
                    result.catch(() => this._finish(request));
            }
            return result;
        } finally {
            if (watch)
                this._tracker.disconnect(watch);
            this._intent = previous;
        }
    }

    _reserve(workspace, appId, context, token) {
        if (!workspace || workspace.index() < 0)
            return;

        const request = {workspace, appId, context, token, pid: 0};
        if (context) {
            context.connectObject(
                'launched', (_context, info, data) => {
                    if (info.get_id() !== appId || startupId(data) !== token)
                        return;
                    request.pid = data?.lookup_value('pid', null)?.get_int32() ?? 0;
                    // The launch is dispatched. This context may be reused.
                    context.disconnectObject(request);
                    request.context = null;
                    for (const window of this._windows.keys())
                        this._place(window);
                },
                'launch-failed', (_context, id) => {
                    if (id === token)
                        this._finish(request);
                }, request);
        }
        request.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LAUNCH_TIMEOUT_SECONDS, () => {
            request.timeout = 0;
            this._finish(request);
            return GLib.SOURCE_REMOVE;
        });
        if (!this.pending.size) {
            global.display.connectObject('window-created', (_display, window) => {
                const type = window.get_window_type();
                if (window.is_on_all_workspaces() || window.get_transient_for() ||
                    (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG &&
                    type !== Meta.WindowType.SPLASHSCREEN))
                    return;

                // An existing window must never satisfy a future launch.
                this._windows.set(window, [...this.pending]);
                if (this._place(window))
                    return;
                window.connectObject('notify::wm-class', () => this._place(window),
                    'notify::gtk-application-id', () => this._place(window),
                    'unmanaged', () => this._forget(window), this);
            }, this);
        }
        this.pending.add(request);
        this._queueCheck();
        return request;
    }

    _place(window) {
        const eligible = this._windows.get(window);
        const token = window.get_startup_id();
        const pid = window.get_pid();
        let matches = eligible.filter(r => token ? r.token === token : pid > 0 && r.pid === pid);
        if (!token && matches.length !== 1) {
            const appId = this._tracker.get_window_app(window)?.get_id();
            const byApp = (matches.length ? matches : eligible).filter(r => r.appId && r.appId === appId);
            if (byApp.length)
                matches = byApp;
        }
        // An expired request can still be an alternative explanation for
        // this window. A timeout does not disambiguate two identical launches.
        const request = matches.find(r => this.pending.has(r));
        if (!request || matches.some(r => r.workspace !== request.workspace))
            return false;

        this._forget(window);
        if (Meta.prefs_get_dynamic_workspaces() && request.workspace.index() >= 0) {
            if (window.get_workspace() !== request.workspace)
                window.change_workspace(request.workspace);
            if (request.token)
                this._guardActivation(request);
        }
        if (window.get_window_type() !== Meta.WindowType.SPLASHSCREEN)
            this._finish(request);
        return true;
    }

    _guardActivation({workspace, token}) {
        // Wayland clients can present their activation token after mapping.
        // Mutter 48 will switch to the window even after the user has left.
        if (!workspace.active) {
            this._retireToken(token);
            return;
        }
        if (this._activations.has(token) ||
            !this._tracker.get_startup_sequences().some(seq => seq.get_id() === token))
            return;

        if (!this._activations.size) {
            global.workspace_manager.connectObject('active-workspace-changed', () => {
                for (const [id, origin] of this._activations) {
                    if (!origin.active) {
                        this._dropActivation(id);
                        if (Meta.prefs_get_dynamic_workspaces())
                            this._retireToken(id);
                    }
                }
            }, this._activations);
            this._tracker.connectObject('startup-sequence-changed', (_tracker, seq) => {
                // A completed sequence can still be redeemed until removal.
                if (this._activations.has(seq.get_id()) &&
                    !this._tracker.get_startup_sequences().includes(seq))
                    this._dropActivation(seq.get_id());
            }, this._activations);
        }
        this._activations.set(token, workspace);
    }

    _retireToken(token) {
        // Mutter exposes exact sequence removal via MetaLaunchContext. Use a
        // separate context so listeners on the successful launch see success.
        this._retirementContext ??= global.create_app_launch_context(0, -1);
        this._retirementContext.launch_failed(token);
    }

    _dropActivation(token) {
        this._activations.delete(token);
        if (!this._activations.size) {
            global.workspace_manager.disconnectObject(this._activations);
            this._tracker.disconnectObject(this._activations);
        }
    }

    _forget(window) {
        window.disconnectObject(this);
        this._windows.delete(window);
    }

    _finish(request) {
        if (!this.pending.delete(request))
            return;
        request.context?.disconnectObject(request);
        request.context = null;
        if (request.timeout)
            GLib.source_remove(request.timeout);
        if (!this.pending.size)
            global.display.disconnectObject(this);
        for (const [window, eligible] of this._windows) {
            if (!eligible.some(r => this.pending.has(r)))
                this._forget(window);
        }
        this._queueCheck();
    }

    clear() {
        for (const id of this._activations.keys())
            this._dropActivation(id);
        for (const request of this.pending)
            this._finish(request);
    }

    destroy() {
        GObject.signal_remove_emission_hook(this._signal, this._hook);
        this.clear();
    }
}
