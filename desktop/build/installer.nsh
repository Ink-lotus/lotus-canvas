Unicode true
!include nsDialogs.nsh
!include FileFunc.nsh

!ifndef BUILD_UNINSTALLER
  Var lotusDirectoryEdit
  Var lotusDirectoryPage
  Var lotusDirectoryPath
  Var lotusDirectoryLeaf
  Var lotusDirectoryLength
  Var lotusDirectoryIndex
  Var lotusDirectoryChar

  ; Replace the native directory page with a custom NSIS page. This keeps the
  ; native folder picker while allowing the normalized path to update immediately.
  !macro customPageAfterChangeDir
    Page custom lotusDirectoryPageCreate lotusDirectoryPageLeave
  !macroend

  Function lotusDirectoryPageCreate
  nsDialogs::Create 1018
  Pop $lotusDirectoryPage
  ${NSD_CreateLabel} 0u 0u 300u 30u "安装程序会将 lotus-canvas 安装到所选目录下的 lotus-canvas 文件夹 / The installer will add a lotus-canvas folder under the selected directory."
  Pop $0
  ${NSD_CreateText} 0u 42u 300u 14u "$INSTDIR"
  Pop $lotusDirectoryEdit
  EnableWindow $lotusDirectoryEdit 0
  ${NSD_CreateButton} 200u 68u 100u 14u "选择目录 / Browse..."
  Pop $0
  ${NSD_OnClick} $0 lotusDirectoryBrowse
  StrCpy $lotusDirectoryPath $INSTDIR
  Call lotusDirectoryPageChanged
  nsDialogs::Show
  FunctionEnd

  Function lotusDirectoryPageLeave
  Call lotusDirectoryPageChanged
  FunctionEnd

  Function lotusDirectoryBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "选择安装目录 / Select installation directory" "$INSTDIR"
  Pop $0
  ${If} $0 != error
    StrCpy $lotusDirectoryPath $0
    Call lotusDirectoryPageChanged
  ${EndIf}
  FunctionEnd

  Function lotusDirectoryPageChanged
  ${If} $lotusDirectoryPath == ""
    StrCpy $lotusDirectoryPath $INSTDIR
  ${EndIf}
  ${If} $lotusDirectoryPath == ""
    Return
  ${EndIf}

  ; Remove trailing separators before checking the final directory name.
  ${Do}
    StrLen $lotusDirectoryLength $lotusDirectoryPath
    ${If} $lotusDirectoryLength == 0
      ${Break}
    ${EndIf}
    IntOp $lotusDirectoryIndex $lotusDirectoryLength - 1
    StrCpy $lotusDirectoryChar $lotusDirectoryPath 1 $lotusDirectoryIndex
    ${If} $lotusDirectoryChar != "\"
      ${Break}
    ${EndIf}
    StrCpy $lotusDirectoryPath $lotusDirectoryPath $lotusDirectoryIndex
  ${Loop}

  ${GetFileName} $lotusDirectoryPath $lotusDirectoryLeaf
  ${If} $lotusDirectoryLeaf != "${APP_FILENAME}"
    StrCpy $lotusDirectoryPath "$lotusDirectoryPath\${APP_FILENAME}"
  ${EndIf}
  StrCpy $INSTDIR $lotusDirectoryPath
  ${NSD_SetText} $lotusDirectoryEdit $lotusDirectoryPath
  FunctionEnd
!endif

; Keep the uninstall welcome page before the optional component selection page.
!macro customUnWelcomePage
  Var lotusUninstallWelcomePage

  Function un.lotusUninstallWelcomePageCreate
    nsDialogs::Create 1018
    Pop $lotusUninstallWelcomePage
    ${NSD_CreateLabel} 0u 0u 300u 24u "卸载 lotus-canvas / Uninstall lotus-canvas"
    Pop $0
    ${NSD_CreateLabel} 0u 34u 300u 42u "即将卸载 lotus-canvas。下一步可选择是否同时删除应用数据。 / lotus-canvas will be removed. The next page lets you optionally delete application data."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function un.lotusUninstallWelcomePageLeave
  FunctionEnd

  UninstPage custom un.lotusUninstallWelcomePageCreate un.lotusUninstallWelcomePageLeave
  Section /o "un.删除应用数据（数据库与默认媒体库） / Delete app data (database and default media library)" lotusDeleteAppData
    ${IfNot} ${isUpdated}
      RMDir /r "$APPDATA\lotus-canvas"
    ${EndIf}
  SectionEnd

  !ifndef MUI_COMPONENTSPAGE_NODESC
    !define MUI_COMPONENTSPAGE_NODESC
  !endif
  !insertmacro MUI_UNPAGE_COMPONENTS
!macroend
