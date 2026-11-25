# SPDX-License-Identifier: GPL-2.0-or-later
"""Executed by the installer with the Debian-gdm account's dconf profile."""

import os
import shutil
import sys
from pathlib import Path

from gi.repository import Gio


def add_setting(settings, key, value):
    current = settings.get_strv(key)
    if value not in current and not settings.set_strv(key, [*current, value]):
        raise RuntimeError(f"Could not set {key}")


def configure():
    uuid = "either-edge-workspaces@local"
    shell = Gio.Settings.new("org.gnome.shell")
    if shell.get_boolean("disable-user-extensions"):
        raise RuntimeError("GDM has disabled extensions in its dconf profile.")
    if Gio.Settings.new("org.gnome.login-screen").get_boolean("disable-user-list"):
        raise RuntimeError("GDM is configured to hide its account chooser.")

    mutter = Gio.Settings.new("org.gnome.mutter")
    session = Gio.Settings.new("org.gnome.SessionManager")
    if "--verify" in sys.argv:
        if (uuid not in shell.get_strv("enabled-extensions") or
            uuid in shell.get_strv("disabled-extensions") or
            "scale-monitor-framebuffer" not in mutter.get_strv("experimental-features")):
            raise RuntimeError("Greeter settings could not be verified.")
        if session.get_boolean("logout-prompt"):
            raise RuntimeError("GDM's session manager still has its power confirmation enabled.")
        return

    directory = Path.home() / ".config"
    directory.mkdir(exist_ok=True, mode=0o700)
    layout = directory / "monitors.xml"
    backup = directory / "monitors.xml.before-workspace-flow"
    if "--backup-layout" in sys.argv and layout.is_file() and not backup.exists():
        with layout.open("rb") as src, backup.open("xb") as dst:
            os.fchmod(dst.fileno(), 0o600)
            shutil.copyfileobj(src, dst)

    # Allow the greeter to load fractional scales saved in Wayland Displays.
    add_setting(mutter, "experimental-features", "scale-monitor-framebuffer")
    # The greeter requests Restart and Power Off through its own session manager.
    if session.get_boolean("logout-prompt") and not session.set_boolean("logout-prompt", False):
        raise RuntimeError("Could not disable the routine power confirmation for GDM.")
    disabled = shell.get_strv("disabled-extensions")
    if uuid in disabled and not shell.set_strv("disabled-extensions", [x for x in disabled if x != uuid]):
        raise RuntimeError("Could not enable Workspace Flow in GDM's dconf profile.")
    add_setting(shell, "enabled-extensions", uuid)
    Gio.Settings.sync()


if __name__ == "__main__":
    configure()
