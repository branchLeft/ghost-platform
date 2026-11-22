#!/usr/bin/env python3
"""The recycle's residue check for the host side of a demo slot.

After `branchleft-slot <slot> reset`, nothing of the previous occupant may
remain where the wrapper is meant to have emptied: the slot directory, both
colours' environment files, and the contents of the slot's data and content
volumes. `residue_of` lists whatever does, one line per find, reading the same
locations `branchleft_slot` wipes (its own constants, never a second copy). An
empty list is the host half of "the slot can be handed on".

Read-only: it opens no file and follows no link. See recycle_residue.md.
"""

from __future__ import annotations

import os
from pathlib import Path

import branchleft_slot as bs


def _entries_under(root: Path, limit: int = 5) -> list[str]:
    """Up to `limit` paths found under `root`, relative to it, links as links.

    A symlink is named, never followed, and a directory is walked only when it
    is a real one: a residue check that followed a planted link would report
    (or miss) something outside the volume.
    """
    found: list[str] = []
    for current, dirs, files in os.walk(root, followlinks=False):
        here = Path(current)
        for name in sorted(dirs + files):
            found.append(str((here / name).relative_to(root)))
            if len(found) >= limit:
                return found
    return found


def residue_of(slot: str, content_volume: str | None) -> list[str]:
    """What of the previous occupant of `slot` is still on the host.

    `content_volume` is the slot's content volume name (`ghost-<slug>-content`),
    which only the slot's own rendered `compose.yml` carries and the reset
    erases with the slot directory, so the caller reads it before the reset.
    `None` means the slot had no content volume.
    """
    found: list[str] = []

    def look(label: str, root: Path) -> None:
        if root.is_symlink() or not root.is_dir():
            return
        left = _entries_under(root)
        if left:
            found.append(f"{label}: still holds {', '.join(left)}")

    look("slot directory", Path(bs.SLOT_DIR.format(slot=slot)))
    for colour in bs.COLOURS:
        env = Path(bs.ETC_DIR, f"demo-{slot}-{colour}.env")
        if env.is_symlink() or env.exists():
            found.append(f"environment file: {env.name} is still there")
    look("data volume", bs._data_directory(slot))
    if content_volume is not None:
        look("content volume", bs._content_directory(content_volume))
    return found
