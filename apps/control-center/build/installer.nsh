!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var LegacyMigrationDetected
Var LegacyMigrationRequested
Var LegacyMigrationCheckbox

!macro customInit
  StrCpy $LegacyMigrationDetected "0"
  StrCpy $LegacyMigrationRequested "0"

  # The public Claude-backed releases are 0.1.x. Read the existing uninstall
  # record before electron-builder removes the old version in the install section.
  ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  StrCpy $1 $0 4
  ${If} $1 == "0.1."
    StrCpy $LegacyMigrationDetected "1"
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom LegacyMigrationPageCreate LegacyMigrationPageLeave
!macroend

Function LegacyMigrationPageCreate
  ${If} $LegacyMigrationDetected != "1"
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "检测到已安装的 Suzu Lives 0.1.x"
  Pop $0
  ${NSD_CreateLabel} 0 30u 100% 52u "0.2.x 已改用新的 Agent Core。可以在安装完成后临时打开迁移助手，把旧联系人、对话和可兼容设置迁入新版。$\r$\n$\r$\n如果暂不迁移，新版会正常安装，旧数据不会被修改。"
  Pop $0
  ${NSD_CreateCheckbox} 0 92u 100% 14u "迁移现有数据（推荐）"
  Pop $LegacyMigrationCheckbox
  ${NSD_SetState} $LegacyMigrationCheckbox ${BST_CHECKED}

  nsDialogs::Show
FunctionEnd

Function LegacyMigrationPageLeave
  ${If} $LegacyMigrationDetected != "1"
    Return
  ${EndIf}
  ${NSD_GetState} $LegacyMigrationCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $LegacyMigrationRequested "1"
  ${Else}
    StrCpy $LegacyMigrationRequested "0"
  ${EndIf}
FunctionEnd

!macro customInstall
  ${If} $LegacyMigrationRequested == "1"
    ExecWait '"$appExe" --legacy-migration' $0
  ${EndIf}
!macroend
!endif
