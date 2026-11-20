' Launches NeonAmp with no console window.
' Use "Start NeonAmp.bat" instead if you want to see error output.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
exe = base & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Electron is not installed yet." & vbCrLf & vbCrLf & _
         "Run ""Start NeonAmp.bat"" once to install dependencies.", _
         vbExclamation, "NeonAmp"
  WScript.Quit 1
End If

shell.CurrentDirectory = base
shell.Run """" & exe & """ """ & base & """", 0, False
