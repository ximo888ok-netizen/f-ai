Unicode true
Name "F-AI Studio"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\F-AI Studio"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show

!include "MUI2.nsh"
!include "x64.nsh"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "F-AI Studio"
VIAddVersionKey "FileDescription" "F-AI Studio Windows Installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "See bundled license notices"
!define APP_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\F-AI-Studio"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\F-AI Studio.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!macro RequireClosed
  System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "Local\FAI.Studio.Desktop") p .r0'
  IntCmp $0 0 workspaceClosed
  System::Call 'kernel32::CloseHandle(p r0)'
  MessageBox MB_OK|MB_ICONEXCLAMATION "请先关闭 F-AI Studio，再继续操作。" /SD IDOK
  SetErrorLevel 16
  Abort
  workspaceClosed:
!macroend

Function .onInit
  SetShellVarContext current
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_OK|MB_ICONEXCLAMATION "此安装包需要 x64 版 Windows。" /SD IDOK
    SetErrorLevel 17
    Abort
  ${EndIf}
  !insertmacro RequireClosed
FunctionEnd

Function un.onInit
  SetShellVarContext current
  !insertmacro RequireClosed
FunctionEnd

Section "F-AI Studio"
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\F-AI Studio.lnk" "$INSTDIR\F-AI Studio.exe"
  WriteRegStr HKCU "${APP_KEY}" "DisplayName" "F-AI Studio"
  WriteRegStr HKCU "${APP_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${APP_KEY}" "DisplayIcon" "$INSTDIR\F-AI Studio.exe"
  WriteRegStr HKCU "${APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${APP_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APP_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\F-AI Studio.lnk"
  DeleteRegKey HKCU "${APP_KEY}"
  !include /CHARSET=UTF8 "${UNINSTALL_FILES}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
