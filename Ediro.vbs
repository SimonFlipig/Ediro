Option Explicit
Dim fso, shell, root, launcher, command, code
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(root, "scripts\launch.ps1")
If Not fso.FileExists(launcher) Then
  MsgBox "Cannot find Ediro launcher: " & launcher, vbCritical, "Ediro"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe") & """ -NoProfile -ExecutionPolicy Bypass -File """ & launcher & """"
code = shell.Run(command, 0, True)
WScript.Quit code
