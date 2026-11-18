; Murshid embeds WebBrain Companion (resources\companion). The tray app keeps
; running after Murshid's windows close, so stop it before uninstalling;
; otherwise its file cannot be deleted while it is in use.
!macro customUnInstall
  DetailPrint "Stopping WebBrain Companion"
  nsExec::Exec 'taskkill /F /T /IM "WebBrainCompanion.exe"'
  Sleep 600
!macroend
