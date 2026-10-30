Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

pyExe = ""

' 1. Check local venv first
If fso.FileExists(scriptDir & "\venv\Scripts\pythonw.exe") Then
    pyExe = scriptDir & "\venv\Scripts\pythonw.exe"
ElseIf fso.FileExists(scriptDir & "\.venv\Scripts\pythonw.exe") Then
    pyExe = scriptDir & "\.venv\Scripts\pythonw.exe"
End If

' 2. Check cached .python_path next
If pyExe = "" Then
    pyPathFile = scriptDir & "\.python_path"
    If fso.FileExists(pyPathFile) Then
        Set file = fso.OpenTextFile(pyPathFile, 1)
        If Not file.AtEndOfStream Then
            cand = Trim(file.ReadLine())
            If cand <> "" And fso.FileExists(cand) Then
                pyExe = cand
            End If
        End If
        file.Close
    End If
End If

' 3. Launch silently if found, else run run.bat
If pyExe <> "" Then
    WshShell.Run """" & pyExe & """ """ & scriptDir & "\app.py""", 0, False
Else
    WshShell.Run """" & scriptDir & "\run.bat""", 0, False
End If

