Set shell = CreateObject("WScript.Shell")
scriptPath = CreateObject("Scripting.FileSystemObject").BuildPath(CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName), "ensure-service.ps1")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """"
shell.Run command, 0, False
