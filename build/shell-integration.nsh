; Ediro Shell integration. Uses the NSIS System plug-in and Windows COM only.
; No third-party Shell plug-in binary is embedded.
!ifndef EDIRO_SHELL_INTEGRATION_INCLUDED
!define EDIRO_SHELL_INTEGRATION_INCLUDED
!include LogicLib.nsh
!include Win\COM.nsh
!include Win\Propkey.nsh

Var EdiroShellResult
!ifdef BUILD_UNINSTALLER | EDIRO_SHELL_TEST
  Var EdiroCustomListResult
  Var EdiroRecentListResult
!endif
!ifdef BUILD_UNINSTALLER
  !define EDIRO_SHELL_PREFIX "un."
!else
  !define EDIRO_SHELL_PREFIX ""
!endif

!macro EdiroSetLnkAUMI LINK APPID
  Push "${LINK}"
  Push "${APPID}"
  Call ${EDIRO_SHELL_PREFIX}EdiroSetLnkAUMI
!macroend
!macro EdiroUninstShortcut LINK
  Push "${LINK}"
  Call ${EDIRO_SHELL_PREFIX}EdiroUninstShortcut
!macroend
!macro EdiroUninstAppUserModelId APPID
  Push "${APPID}"
  Call ${EDIRO_SHELL_PREFIX}EdiroUninstAppUserModelId
!macroend

!ifndef BUILD_UNINSTALLER
Function EdiroSetLnkAUMI
  Exch $1
  Exch 1
  Exch $0
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  StrCpy $2 0
  StrCpy $3 0
  StrCpy $4 0
  StrCpy $5 0
  StrCpy $6 0
  StrCpy $8 0
  StrCpy $EdiroShellResult 0
  System::Call 'ole32::CoInitializeEx(p 0, i 2) i.r7'
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r2 .r9
  StrCpy $EdiroShellResult $9
  ${If} $9 < 0
    Goto ediro_aumi_done
  ${EndIf}
  ${IUnknown::QueryInterface} $2 '("${IID_IPersistFile}",.r3).r9'
  StrCpy $EdiroShellResult $9
  ${If} $9 < 0
    Goto ediro_aumi_done
  ${EndIf}
  ${IPersistFile::Load} $3 '(r0, 2).r9'
  StrCpy $EdiroShellResult $9
  ${If} $9 < 0
    Goto ediro_aumi_done
  ${EndIf}
  ${IUnknown::QueryInterface} $2 '("${IID_IPropertyStore}",.r4).r9'
  StrCpy $EdiroShellResult $9
  ${If} $9 < 0
    Goto ediro_aumi_done
  ${EndIf}
  System::Call 'oleaut32::SysAllocString(w r1) p.r8'
  ${If} $8 P= 0
    StrCpy $EdiroShellResult 0x8007000e
    Goto ediro_aumi_done
  ${EndIf}
  System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ID})p.r5'
  System::Call '*${SYSSTRUCT_PROPVARIANT}(${VT_BSTR},, p r8)p.r6'
  ${IPropertyStore::SetValue} $4 '(r5, r6).r9'
  StrCpy $EdiroShellResult $9
  ${If} $9 < 0
    Goto ediro_aumi_done
  ${EndIf}
  ${IPropertyStore::Commit} $4 '().r9'
  StrCpy $EdiroShellResult $9
  ${If} $9 < 0
    Goto ediro_aumi_done
  ${EndIf}
  ${IPersistFile::Save} $3 '(r0, 1).r9'
  StrCpy $EdiroShellResult $9
ediro_aumi_done:
  ${If} $8 P<> 0
    System::Call 'oleaut32::SysFreeString(p r8)'
  ${EndIf}
  ${If} $5 P<> 0
    System::Free $5
  ${EndIf}
  ${If} $6 P<> 0
    System::Free $6
  ${EndIf}
  !insertmacro ComHlpr_SafeRelease $4
  !insertmacro ComHlpr_SafeRelease $3
  !insertmacro ComHlpr_SafeRelease $2
  ${If} $7 >= 0
    System::Call 'ole32::CoUninitialize()'
  ${EndIf}
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $0
  Pop $1
FunctionEnd
!endif

Function ${EDIRO_SHELL_PREFIX}EdiroUninstShortcut
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $1 0
  StrCpy $2 0
  System::Call 'ole32::CoInitializeEx(p 0, i 2) i.r3'
  System::Call 'shell32::SHCreateItemFromParsingName(w r0, p 0, g "${IID_IShellItem}", *p.r1) i.r4'
  StrCpy $EdiroShellResult $4
  ${If} $4 >= 0
    !insertmacro ComHlpr_CreateInProcInstance ${CLSID_StartMenuPin} ${IID_IStartMenuPinnedList} r2 .r4
    StrCpy $EdiroShellResult $4
    ${If} $4 >= 0
      ${IStartMenuPinnedList::RemoveFromList} $2 '(r1).r4'
      StrCpy $EdiroShellResult $4
    ${EndIf}
  ${EndIf}
  !insertmacro ComHlpr_SafeRelease $2
  !insertmacro ComHlpr_SafeRelease $1
  ${If} $3 >= 0
    System::Call 'ole32::CoUninitialize()'
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!ifdef BUILD_UNINSTALLER | EDIRO_SHELL_TEST
; Windows SDK interface layout: DeleteList is slot 10; SetAppID and
; RemoveAllDestinations are slots 3 and 5 of IApplicationDestinations.
Function ${EDIRO_SHELL_PREFIX}EdiroUninstAppUserModelId
  Exch $0
  Push $1
  Push $2
  Push $3
  StrCpy $1 0
  StrCpy $EdiroCustomListResult 0
  StrCpy $EdiroRecentListResult 0
  System::Call 'ole32::CoInitializeEx(p 0, i 2) i.r2'
  System::Call 'ole32::CoCreateInstance(g "{77f10cf0-3db5-4966-b520-b7c54fd35ed6}", p 0, i 1, g "{6332debf-87b5-4670-90c0-5e57b408a49e}", *p.r1) i.r3'
  StrCpy $EdiroCustomListResult $3
  ${If} $3 >= 0
    System::Call '$1->10(w r0) i.r3'
    StrCpy $EdiroCustomListResult $3
    ${IUnknown::Release} $1 ""
  ${EndIf}
  StrCpy $1 0
  System::Call 'ole32::CoCreateInstance(g "{86c14003-4d6b-4ef3-a7b4-0506663b2e68}", p 0, i 1, g "{12337d35-94c6-48a0-bce7-6a9c69d4d600}", *p.r1) i.r3'
  StrCpy $EdiroRecentListResult $3
  ${If} $3 >= 0
    System::Call '$1->3(w r0) i.r3'
    StrCpy $EdiroRecentListResult $3
    ${If} $3 >= 0
      System::Call '$1->5() i.r3'
      StrCpy $EdiroRecentListResult $3
    ${EndIf}
    ${IUnknown::Release} $1 ""
  ${EndIf}
  StrCpy $EdiroShellResult $EdiroCustomListResult
  ${If} $EdiroShellResult >= 0
    StrCpy $EdiroShellResult $EdiroRecentListResult
  ${EndIf}
  ${If} $2 >= 0
    System::Call 'ole32::CoUninitialize()'
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif
!endif
