# Cloud browser handoff

Cloud runtimes advertise browser handoff through `run_handoff_v1`.

`cloud_pause` requests manual browser control for the existing run. The run stays
reserved while it is `pausing`; a writable `paused` acknowledgement follows only
after the current model/tool boundary settles and the handoff guard is saved.
Pausing a run does not suspend or power off its browser session.

`cloud_resume` returns control with an optional note. DIV reads the current
page before further work. The note reports state and grants no new task authority.
An existing clarification remains pending and requires its original explicit answer.

The durable `webbrainCloudHandoffGuards` record contains only run ID, tab ID, and
timestamps. Provider credentials, task content, notes, memory, and results are not
stored in this guard. A service worker restart, extension reload/update, or browser
restart restores manual ownership as interrupted and nonresumable. It never replays
the old task. Inspect the browser and explicitly abort the interrupted run before
starting further work. Other agents, scheduled runs, and Cloud tasks remain blocked
on that profile until reconciliation completes.

The guard clears only after a fresh handback observation is saved or explicit
cancellation confirms the native handler has settled, including recording cleanup.
Storage failures keep the browser read-only and preserve its reservation.
