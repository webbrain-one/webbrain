import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui as Ui

Ui.BarWidget {
  id: root
  moduleName: "webbrain.browser"

  // Omarchy routes shell summons to a bar widget that exposes this contract.
  // The nested panel uses the widget as its identity for popout coordination.
  readonly property bool opened: webbrainPanel.opened
  readonly property bool popoutSwitchClosing: webbrainPanel.popoutSwitchClosing

  function open(payloadJson) { webbrainPanel.open(payloadJson) }
  function close() { webbrainPanel.close() }
  function closeForPopoutSwitch() { webbrainPanel.closeForPopoutSwitch() }
  function refresh() { webbrainPanel.refresh() }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Ui.BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰖟"
    tooltipText: "WebBrain · " + webbrainPanel.readinessLabel

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.MiddleButton) root.refresh()
      else webbrainPanel.toggle()
    }

    Rectangle {
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.margins: Style.space(3)
      width: Style.space(5)
      height: width
      radius: width / 2
      color: webbrainPanel.ready ? Commons.Color.accent : Commons.Color.muted
      visible: !webbrainPanel.checking
    }
  }

  WebBrainPanel {
    id: webbrainPanel
    bar: root.bar
    settings: root.settings
    anchorItem: button
    hostWidget: root
  }
}
