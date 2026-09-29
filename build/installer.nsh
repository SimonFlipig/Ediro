!include LogicLib.nsh
!include FileFunc.nsh

!ifndef BUILD_UNINSTALLER
  LangString EdiroDirectoryHelp 2052 "请选择当前权限可写的安装目录。默认目录无需管理员权限；如需安装到 Program Files，请返回并选择为所有用户安装，再允许 Windows 权限请求。无法写入的目录不能继续安装。"
  LangString EdiroDirectoryHelp 1033 "Choose a writable folder. The default folder needs no administrator rights. For Program Files, go back, choose installation for all users and approve the Windows permission request. An unwritable folder cannot be used."
  !define MUI_DIRECTORYPAGE_TEXT_TOP "$(EdiroDirectoryHelp)"

  Var EdiroDirectoryWritable

  ; Check the actual token's access to the target or nearest existing parent.
  ; Opening a directory handle checks ACLs without creating files or directories.
  Function EdiroCheckDirectoryAccess
    Push $0
    Push $1
    Push $2
    StrCpy $EdiroDirectoryWritable "0"
    StrCpy $0 $INSTDIR
    ediro_find_parent:
      System::Call 'kernel32::GetFileAttributesW(w r0) i.r1 ?e'
      Pop $2
      ${If} $1 == -1
        ${If} $2 != 2
        ${AndIf} $2 != 3
          Goto ediro_access_done
        ${EndIf}
        ${GetParent} "$0" $1
        ${If} $1 == ""
        ${OrIf} $1 == $0
          Goto ediro_access_done
        ${EndIf}
        StrCpy $0 $1
        Goto ediro_find_parent
      ${EndIf}
      IntOp $2 $1 & 0x10
      ${If} $2 == 0
        Goto ediro_access_done
      ${EndIf}
      ; FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY, share all, OPEN_EXISTING,
      ; FILE_FLAG_BACKUP_SEMANTICS (required for directory handles).
      System::Call 'kernel32::CreateFileW(w r0, i 0x6, i 7, p 0, i 3, i 0x02000000, p 0) p.r1'
      ${If} $1 != -1
        System::Call 'kernel32::CloseHandle(p r1)'
        StrCpy $EdiroDirectoryWritable "1"
      ${EndIf}
    ediro_access_done:
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  Function .onVerifyInstDir
    Call EdiroCheckDirectoryAccess
    ${If} $EdiroDirectoryWritable != "1"
      Abort
    ${EndIf}
  FunctionEnd
!endif
