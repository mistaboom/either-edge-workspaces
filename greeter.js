// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AuthPromptStatus} from 'resource:///org/gnome/shell/gdm/authPrompt.js';
import {LoginDialog} from 'resource:///org/gnome/shell/gdm/loginDialog.js';
import {TransientSignalHolder} from 'resource:///org/gnome/shell/misc/signalTracker.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function soleLoginItem(dialog) {
    const prompt = dialog._authPrompt;
    if (dialog._disableUserList !== false || !dialog._userSelectionBox.visible ||
        prompt.verificationStatus !== AuthPromptStatus.NOT_VERIFYING ||
        prompt._userVerifier.foregroundServiceDeterminesUsername() ||
        dialog._timedLoginBatch || dialog._userList.numItems() !== 1)
        return null;

    // Cross-check the displayed row against AccountsService. An incomplete
    // or changing account list leaves the decision with GDM.
    const users = dialog._userManager.list_users();
    if (users.some(user => !user.is_loaded))
        return null;
    const eligible = users.filter(user => !user.locked && !user.is_system_account() && user.get_user_name());
    if (eligible.length !== 1)
        return null;
    return dialog._userList.getItemFromUserName(eligible[0].get_user_name());
}

export function watchLoginChooser() {
    const hooks = new InjectionManager();
    const signals = new TransientSignalHolder();
    const watched = new WeakSet();
    const settled = new WeakSet();

    const consider = dialog => {
        if (settled.has(dialog))
            return;
        if (!watched.has(dialog)) {
            watched.add(dialog);
            const leaveToUser = () => settled.add(dialog);
            dialog._authPrompt.connectObject('cancelled', leaveToUser, 'failed', leaveToUser, signals);
            dialog._userSelectionBox.connectObject('notify::visible', box => {
                if (!box.visible && dialog._disableUserList === false)
                    leaveToUser();
            }, signals);
        }
        if (!dialog._userListLoaded || !dialog._greeter || !dialog._userSelectionBox.visible)
            return;
        if (dialog._userList.numItems() > 1) {
            settled.add(dialog);
            return;
        }
        const item = soleLoginItem(dialog);
        if (!item)
            return;
        // Returning from this account's authentication must leave the normal
        // chooser available, including the “Not listed?” option.
        settled.add(dialog);

        // The timed-login notification may arrive after the rows are loaded.
        // Ask GDM before selecting and leave its countdown to the greeter.
        const request = new Gio.Cancellable();
        const lifetime = new TransientSignalHolder(signals);
        lifetime.connect('destroy', () => request.cancel());
        const cancelRequest = () => lifetime.destroy();
        dialog.connectObject('destroy', cancelRequest, lifetime);
        dialog._authPrompt.connectObject('cancelled', cancelRequest, 'failed', cancelRequest, lifetime);
        dialog._userSelectionBox.connectObject('notify::visible', cancelRequest, lifetime);
        // The generated Gdm finish method prepends the call-success flag to
        // its output values in GJS. Read the D-Bus (enabled, user, delay) reply.
        dialog._greeter.call('GetTimedLoginDetails', null, Gio.DBusCallFlags.NONE, -1, request, (greeter, result) => {
            let select = false;
            try {
                const [timedLogin] = greeter.call_finish(result).deepUnpack();
                select = !request.is_cancelled() && !timedLogin && soleLoginItem(dialog) === item;
            } catch (error) {
                if (!request.is_cancelled())
                    console.warn(`Workspace Flow could not check GDM timed login: ${error.message}`);
            } finally {
                if (!request.is_cancelled())
                    lifetime.destroy();
            }
            if (select)
                item.emit('activate');
        });
    };

    // Shell 48 fills the model and shows the chooser on distinct paths.
    // Recheck after either completes, including subsequent account updates.
    for (const method of ['_updateDisableUserList', '_showUserList']) {
        hooks.overrideMethod(LoginDialog.prototype, method, original => function () {
            const result = original.call(this);
            consider(this);
            return result;
        });
    }
    const dialog = Main.screenShield?._dialog;
    if (dialog instanceof LoginDialog)
        consider(dialog);
    return () => {
        hooks.clear();
        signals.destroy();
    };
}
