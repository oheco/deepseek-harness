# Agent Note: HarmonyOS publication without hard links

Status: implemented

English | [中文](2026-09-13-harmonyos-no-replace-publication.zh.md)

## Problem

HarmonyOS application filesystems deny `link(2)` with `EPERM`. Two shipped paths still published through hard links, so they failed while replacements through `rename(2)` kept working:

- `dsh-fs-local` guarded creation (`createIfAbsent`, the `write` tool's new-file path) failed every new-file write with the raw `EPERM`.
- `dsh-attachment-local` object and alias publication failed every image, generic-file and stored-file save with `Unable to persist attachment.`

The attachment store also proved DSH_HOME durable by fsyncing every ancestor up to the filesystem root. HarmonyOS mounts `/storage` and `/storage/Users` execute-only (`drwx--x--x`), so `open(directory, O_RDONLY)` fails there and no attachment could be stored at all.

## Decision

`dsh-fs-local` and `dsh-attachment-local` each own a private `src/ohos.ts` that binds `renameat2(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE)` through Koffi, mirroring the JSONL publication decision in the [HarmonyOS runtime note](../architecture/2026-09-12-harmonyos-runtime.md). Guarded creation keeps its no-replace guarantee: an existing target reports `EEXIST`, which the filesystem seam maps to `FS_NOT_OBSERVED`; the attachment store verifies the existing object's digest instead. Filesystems without `RENAME_NOREPLACE` reject publication; there is no overwrite or partial-copy fallback.

The selector is `internals.platform ?? process.platform === 'openharmony'`; other hosts keep `link(2)`. Both packages expose the publication boundary as a documented test hook, so the platform path is covered on every host.

The attachment alias must leave the object in place, so on HarmonyOS it becomes an exclusive copy (`COPYFILE_EXCL`) plus an fsync of the copied inode. The bytes are content-addressed and immutable, so a copy preserves the reference contract at the cost of duplicated bytes.

`ensureDurableHome` stops its ancestor walk at the first directory the process may not open (`EACCES`/`EPERM`) instead of failing. A platform-owned mount point cannot be created or dropped by this app, so the entries already synced below it are the boundary; publication directories inside the attachment root keep the strict walk.

## Alternatives considered

**Reserve the target and rename over it.** `open(target, 'wx')` followed by `rename` needs no new dependency, but a reader can observe the empty placeholder, and a concurrent writer of the same content can then fail digest verification. `RENAME_NOREPLACE` publishes complete bytes with no window.

**Copy the staged file with `COPYFILE_EXCL`.** It has the same reader window and cannot consume the staging name, so the object publication still needs a move.

**Symlink aliases on HarmonyOS.** A symlink changes the entry type that consumers and trust checks observe; a copy keeps a regular read-only file.

**Skip the ancestor walk on HarmonyOS.** The walk also proves DSH_HOME durable after a concurrent creator; only the platform-owned prefix is dropped.

## Consequences

New-file writes (`write`, `str_replace_editor` create) and attachment or stored-file saves work on HarmonyOS, and a concurrent creator is still refused. Generic stored files occupy one copy per name there instead of sharing one object inode. `dsh-attachment-local` declares `koffi` as a runtime dependency, so the reviewed lockfile pin in `ohos/release.json` moves with it. Durability on HarmonyOS is proven up to the first platform-owned ancestor rather than the filesystem root. POSIX mode bits are not enforced on HarmonyOS application filesystems, so the owner-only staging modes and read-only object modes remain conventions backed by the application sandbox rather than by the filesystem.
