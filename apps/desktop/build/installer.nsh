; Keep first-install pages separate from the unattended update path.
; MUI supplies localized welcome/finish text for the configured languages.
!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend
