; Expanded from config/fileTypes.json by the beforeBundleCommand hook.
; SHCTX follows Tauri's installer scope. Existing defaults belong to Windows.
!macro SideralDefineRegistration
  !ifndef SideralFileClass
    !define SideralFileClass "${BUNDLEID}.Text"
    !define SideralCapabilities "Software\${BUNDLEID}\Capabilities"
  !endif
!macroend

!macro SideralRegisterExtension Extension
  WriteRegStr SHCTX "Software\Classes\.${Extension}\OpenWithProgids" "${SideralFileClass}" ""
  WriteRegStr SHCTX "${SideralCapabilities}\FileAssociations" ".${Extension}" "${SideralFileClass}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${Extension}" ""
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${Extension}\shell\${BUNDLEID}" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${Extension}\shell\${BUNDLEID}" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${Extension}\shell\${BUNDLEID}" "MultiSelectModel" "Document"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${Extension}\shell\${BUNDLEID}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" -- "%1"'
!macroend

!macro SideralRemoveExtension Extension
  DeleteRegValue SHCTX "Software\Classes\.${Extension}\OpenWithProgids" "${SideralFileClass}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${Extension}\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${Extension}"
  ReadRegStr $R0 SHCTX "Software\Classes\SystemFileAssociations\.${Extension}\shell\${BUNDLEID}\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" -- "%1"'
    DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.${Extension}\shell\${BUNDLEID}"
    DeleteRegKey /ifempty SHCTX "Software\Classes\SystemFileAssociations\.${Extension}\shell"
    DeleteRegKey /ifempty SHCTX "Software\Classes\SystemFileAssociations\.${Extension}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SideralDefineRegistration
  WriteRegStr SHCTX "Software\Classes\${SideralFileClass}" "" "Sideral source or text file"
  WriteRegStr SHCTX "Software\Classes\${SideralFileClass}\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\${SideralFileClass}\shell\open" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${SideralFileClass}\shell\open" "MultiSelectModel" "Document"
  WriteRegStr SHCTX "Software\Classes\${SideralFileClass}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" -- "%1"'
  WriteRegStr SHCTX "Software\Classes\${SideralFileClass}\Application" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${SideralFileClass}\Application" "ApplicationIcon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" -- "%1"'
  WriteRegStr SHCTX "${SideralCapabilities}" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${SideralCapabilities}" "ApplicationDescription" "A focused, native code editor"
  WriteRegStr SHCTX "${SideralCapabilities}" "ApplicationIcon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "${SideralCapabilities}"
  WriteRegStr SHCTX "Software\Classes\*\shell\${BUNDLEID}.NamedFile" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\*\shell\${BUNDLEID}.NamedFile" "AppliesTo" '@namedFileQuery@'
  WriteRegStr SHCTX "Software\Classes\*\shell\${BUNDLEID}.NamedFile" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\*\shell\${BUNDLEID}.NamedFile" "MultiSelectModel" "Document"
  WriteRegStr SHCTX "Software\Classes\*\shell\${BUNDLEID}.NamedFile\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" -- "%1"'
@registerExtensions@
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro SideralDefineRegistration
  ; An old installation must not remove registrations owned by a newer path.
  ReadRegStr $R0 SHCTX "Software\Classes\${SideralFileClass}\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" -- "%1"'
@removeExtensions@
    DeleteRegKey SHCTX "Software\Classes\${SideralFileClass}"
    DeleteRegKey SHCTX "${SideralCapabilities}"
    DeleteRegKey /ifempty SHCTX "Software\${BUNDLEID}"
    DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
  ${EndIf}
  ReadRegStr $R0 SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" -- "%1"'
    DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  ${EndIf}
  ReadRegStr $R0 SHCTX "Software\Classes\*\shell\${BUNDLEID}.NamedFile\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" -- "%1"'
    DeleteRegKey SHCTX "Software\Classes\*\shell\${BUNDLEID}.NamedFile"
  ${EndIf}
  !insertmacro UPDATEFILEASSOC
!macroend
