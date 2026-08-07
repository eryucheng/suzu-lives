Option Explicit

Dim shell
Dim fileSystem
Dim projectRoot

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
projectRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)

shell.CurrentDirectory = projectRoot
shell.Run "cmd.exe /d /c npm start", 0, False
