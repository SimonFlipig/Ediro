# Windows Shell integration without WinShell.dll

Ediro keeps electron-builder's standard installer, upgrade and two-stage uninstaller generation. `scripts/prepare-nsis-template.mjs` creates an immutable local mirror of the installed templates. It checks the exact SHA256 of four integration files, replaces exactly five AUMI writes, four shortcut cleanup calls and one application cleanup call, and rejects any remaining `WinShell::` command anywhere in the mirror. Neither `node_modules` nor the user's installed application is changed.

`build/installer.nsh` selects this verified compilation directory. Its root `installer.nsh` shadows the original helper include; the default `installer.nsi` remains in use, including electron-builder's uninstaller preparation. Missing preparation is a compilation error. The packaging entry point prepares the mirror and sets `EDIRO_NSIS_TEMPLATE_DIRECTORY` before invoking electron-builder.

The replacements in `shell-integration.nsh` use the already supplied NSIS System plug-in and Windows COM:

- `EdiroSetLnkAUMI` loads the shortcut through `IPersistFile`, sets `PKEY_AppUserModel_ID` using `IPropertyStore`, then saves the same shortcut. The app ID, shortcut paths, creation/rename conditions and other shortcut fields remain those selected by electron-builder.
- `EdiroUninstAppUserModelId` calls `ICustomDestinationList::DeleteList` and `IApplicationDestinations::SetAppID` / `RemoveAllDestinations` for the exact application ID. It stays inside the existing `keep-shortcuts` condition.
- `EdiroUninstShortcut` calls `SHCreateItemFromParsingName` and `IStartMenuPinnedList::RemoveFromList` before the existing shortcut deletion. Windows controls which pinned representations this documented interface supports. This does not add undocumented taskbar manipulation or remove users' pinned Jump List entries.

The routines preserve NSIS registers and stack, release COM objects and allocated property values, and only balance `CoUninitialize` after successful initialization. HRESULTs are retained for verification; cleanup remains best effort as in the original template.

## Repeatable checks

Run `node build/verify-shell-integration.mjs` on Windows. This builds and executes a silent test executable against a new local `.lnk` and random AppUserModelID. It reads the saved AUMI and other shortcut fields back through Windows Shell, checks stack/register preservation and a missing-file failure, and invokes the cleanup interfaces. This test does not pin a shortcut or create a populated Jump List, and does not execute an Ediro install, upgrade or uninstall.

Run `node build/verify-shell-template.mjs <win-unpacked-directory>` for a full standard NSIS build using a separate copy of the supplied payload and a random test application ID. It does not run the resulting installer. Set `EDIRO_AUDIT_7ZIP_PATH` to the full official `7z.exe` distribution, alongside its `7z.dll`; the reduced `7za.exe` lacks the NSIS handler.

The reusable `verifyInstallerShell` function in `build/verify-installer-shell.mjs` extracts both the setup and its unique embedded `Uninstall *.exe`, requires the System plug-in in each, rejects WinShell.dll in either, and records all plugin hashes. Packaging runs this check on the final installer. A successful archive check is not a claim that a real user installation was upgraded or uninstalled.

## API references

- [Microsoft: Application User Model IDs](https://learn.microsoft.com/en-us/windows/win32/shell/appids)
- [Microsoft: ICustomDestinationList::DeleteList](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-icustomdestinationlist-deletelist)
- [Microsoft: IApplicationDestinations](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-iapplicationdestinations)
- [Microsoft: IStartMenuPinnedList::RemoveFromList](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl/nf-shobjidl-istartmenupinnedlist-removefromlist)
- [NSIS author guidance on the System/COM replacement](https://nsis-dev.github.io/forum-archive/thread/4768183/creating-a-shortcut-with-an-appusermodelid-using-the-system-plug-in/)

This is Ediro source under the repository license. It uses the COM interface declarations already provided in NSIS; it does not copy or redistribute the unavailable WinShell plug-in implementation.
