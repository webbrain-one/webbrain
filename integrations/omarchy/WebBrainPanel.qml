import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui as Ui

Ui.Panel {
  id: root
  moduleName: "webbrain.browser"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property bool checking: false
  property bool helperAvailable: false
  property bool installed: false
  property bool mcpReady: false
  property string agent: ""
  property string statusMessage: "Check setup to connect your browser."
  property string actionError: ""
  property string actionNotice: ""
  property string draft: ""
  property bool acting: false
  property string actionKind: ""
  property bool statusExited: false
  property bool statusCollected: false
  property int statusExitCode: -1
  property string statusOutput: ""

  readonly property bool ready: helperAvailable && installed && mcpReady && agent !== ""
  readonly property string readinessLabel: checking ? "Checking setup" : ready ? "Configured for " + agent : "Setup needed"
  readonly property bool canSubmit: ready && !checking && !acting && draft.trim().length > 0
  readonly property var barIdentity: hostWidget || root

  function open(payloadJson) {
    root.controller.show()
    refresh()
    Qt.callLater(function() {
      if (root.opened && panel.loadedContent) panel.loadedContent.focusPrompt()
    })
  }

  function close() { root.controller.hide() }
  function toggle() { root.opened ? close() : open("{}") }

  function refresh() {
    if (root.checking || statusProc.running) return
    root.checking = true
    root.statusExited = false
    root.statusCollected = false
    root.statusOutput = ""
    root.statusExitCode = -1
    statusWatchdog.restart()
    statusProc.running = true
  }

  function statusFailed(message) {
    root.checking = false
    root.helperAvailable = false
    root.installed = false
    root.mcpReady = false
    root.agent = ""
    root.statusMessage = message
    root.statusOutput = ""
    statusWatchdog.stop()
  }

  function finishStatus() {
    // Process exit and the collector's final bytes may arrive in either order.
    if (!root.checking || !root.statusExited || !root.statusCollected) return
    if (root.statusExitCode !== 0) {
      statusFailed("Setup check failed. Run webbrain-omarchy status --json in a terminal.")
      return
    }
    try {
      var result = JSON.parse(root.statusOutput)
      if (!result || typeof result.installed !== "boolean" || typeof result.mcpReady !== "boolean")
        throw new Error("Unexpected setup result")
      root.helperAvailable = true
      root.installed = result.installed
      root.mcpReady = result.mcpReady
      root.agent = typeof result.agent === "string" ? result.agent.slice(0, 80) : ""
      root.statusMessage = typeof result.message === "string" ? result.message.slice(0, 500) : "Open the guide to finish setup."
      root.checking = false
      statusWatchdog.stop()
    } catch (error) {
      statusFailed("Setup returned an unreadable result. Update the WebBrain helper and try again.")
    }
    root.statusOutput = ""
  }

  function runAction(kind, argv) {
    if (root.acting) return
    root.actionError = ""
    root.actionNotice = ""
    root.actionKind = kind
    root.acting = true
    actionProc.command = argv
    actionWatchdog.restart()
    actionProc.running = true
  }

  function submit() {
    if (!root.canSubmit) return
    runAction("launch", ["webbrain-omarchy", "launch", "--task", root.draft.trim()])
  }

  function openDestination(destination) {
    if (destination === "docs" && !root.helperAvailable) {
      if (!Qt.openUrlExternally("https://webbrain.one/docs/omarchy/"))
        root.actionError = "Could not open the guide. Visit webbrain.one/docs/omarchy in your browser."
      return
    }
    runAction("open", ["webbrain-omarchy", "open", destination])
  }

  Component.onCompleted: refresh()

  Process {
    id: statusProc
    command: ["webbrain-omarchy", "status", "--json"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root.checking) return
        root.statusOutput = String(text || "")
        root.statusCollected = true
        root.finishStatus()
      }
    }
    // Never render arbitrary helper diagnostics or forward them to shell logs.
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      root.statusExitCode = exitCode
      root.statusExited = true
      root.finishStatus()
    }
  }

  Timer {
    id: statusWatchdog
    interval: 8000
    onTriggered: {
      root.statusFailed("WebBrain helper unavailable. Install the Omarchy integration, then refresh setup.")
      if (statusProc.running) statusProc.running = false
    }
  }

  Process {
    id: actionProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (!root.acting) {
        actionProc.command = []
        return
      }
      actionWatchdog.stop()
      root.acting = false
      if (exitCode !== 0) {
        root.actionError = "Could not open WebBrain. Check the helper in a terminal, then try again."
      } else if (root.actionKind === "launch") {
        root.actionNotice = "Task handed to " + root.agent + ". Continue in its window."
        root.draft = ""
      }
      // Task text is needed only until the helper hands it to the agent.
      actionProc.command = []
    }
  }

  Timer {
    id: actionWatchdog
    interval: 15000
    onTriggered: {
      root.acting = false
      root.actionError = "Could not confirm the launch. Check your agent or browser window before trying again."
      if (actionProc.running) actionProc.running = false
    }
  }

  Ui.KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: panel.loadedContent ? panel.loadedContent.promptField : null
    contentWidth: panel.fittedContentWidth(Style.space(480))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight)

    content: FocusScope {
      id: contentRoot
      property alias promptField: prompt
      implicitHeight: column.implicitHeight
      anchors.fill: parent

      function focusPrompt() { prompt.forceActiveFocus() }
      Keys.onEscapePressed: root.close()

      Flickable {
        id: scroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        ColumnLayout {
          id: column
          width: scroll.width
          spacing: Style.space(16)

          RowLayout {
            Layout.fillWidth: true
            spacing: Style.space(12)

            ColumnLayout {
              Layout.fillWidth: true
              spacing: Style.space(4)
              Text {
                text: "WebBrain"
                textFormat: Text.PlainText
                color: Commons.Color.popups.text
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
              }
              Text {
                text: "Browser tasks, through your own agent."
                textFormat: Text.PlainText
                color: Commons.Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.Wrap
                Layout.fillWidth: true
              }
            }

            Ui.Button {
              text: "×"
              tooltipText: "Close · Esc"
              focusable: true
              onClicked: root.close()
            }
          }

          Rectangle {
            Layout.fillWidth: true
            implicitHeight: 1
            color: Commons.Color.popups.border
            opacity: 0.25
          }

          ColumnLayout {
            Layout.fillWidth: true
            spacing: Style.space(7)

            RowLayout {
              Layout.fillWidth: true
              Text {
                text: root.readinessLabel
                textFormat: Text.PlainText
                color: root.ready ? Commons.Color.accent : Commons.Color.popups.text
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                font.bold: true
                wrapMode: Text.Wrap
                Layout.fillWidth: true
              }
              Ui.Button {
                text: root.checking ? "Checking…" : "Refresh"
                focusable: true
                enabled: !root.checking
                opacity: enabled ? 1 : 0.6
                onClicked: root.refresh()
              }
            }

            Text {
              text: root.checking ? "Checking your selected agent and WebBrain configuration…" : root.statusMessage
              textFormat: Text.PlainText
              color: Commons.Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.Wrap
              Layout.fillWidth: true
            }
          }

          ColumnLayout {
            Layout.fillWidth: true
            spacing: Style.space(8)

            Text {
              text: "What would you like to do?"
              textFormat: Text.PlainText
              color: Commons.Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Ui.TextField {
              id: prompt
              Layout.fillWidth: true
              text: root.draft
              placeholderText: "Compare the pages I have open…"
              selectByMouse: true
              maximumLength: 12000
              readOnly: root.acting
              foreground: Commons.Color.popups.text
              onTextEdited: root.draft = text
              onAccepted: root.submit()
              Keys.onEscapePressed: root.close()
              Accessible.name: "Browser task"
            }

            Ui.Button {
              Layout.fillWidth: true
              text: root.acting && root.actionKind === "launch" ? "Opening agent…" : "Open in " + (root.agent || "your agent")
              focusable: true
              bordered: true
              selected: root.canSubmit
              enabled: root.canSubmit
              opacity: enabled ? 1 : 0.5
              onClicked: root.submit()
            }

            Text {
              text: "Pair the WebBrain extension in your browser before your first task."
              textFormat: Text.PlainText
              color: Commons.Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.Wrap
              Layout.fillWidth: true
            }
          }

          Text {
            visible: root.actionError !== "" || root.actionNotice !== ""
            text: root.actionError || root.actionNotice
            textFormat: Text.PlainText
            color: root.actionError ? Commons.Color.urgent : Commons.Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          RowLayout {
            Layout.fillWidth: true
            spacing: Style.space(4)
            Ui.Button {
              Layout.fillWidth: true
              text: "Extension"
              tooltipText: "Open WebBrain's extension page"
              focusable: true
              enabled: root.helperAvailable && !root.acting
              opacity: enabled ? 1 : 0.5
              onClicked: root.openDestination("extension")
            }
            Ui.Button {
              Layout.fillWidth: true
              text: "Cloud"
              tooltipText: "Open the WebBrain Cloud dashboard"
              focusable: true
              enabled: root.helperAvailable && !root.acting
              opacity: enabled ? 1 : 0.5
              onClicked: root.openDestination("cloud")
            }
            Ui.Button {
              Layout.fillWidth: true
              text: "Guide"
              focusable: true
              enabled: !root.acting
              opacity: enabled ? 1 : 0.5
              onClicked: root.openDestination("docs")
            }
          }
        }
      }
    }
  }
}
