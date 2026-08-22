!macro customUnInit
  ; Electron stores installed-app data in %APPDATA%\lotus-canvas. A separately
  ; selected media-library directory outside this tree is never touched.
  ${ifNot} ${isUpdated}
    ${GetParameters} $R0
    ${GetOptions} $R0 "/S" $R1
    ${If} ${Errors}
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "Do you also want to delete your lotus-canvas data (canvas, settings, and media)?" \
        IDNO keep_lotus_data
      RMDir /r "$APPDATA\lotus-canvas"
    ${EndIf}
  ${EndIf}
  keep_lotus_data:
!macroend
