package d1

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/esokullu/webbrain-systray/internal/settings"
)

func TestInstallClaimsPhaseBeforeWorkerStarts(t *testing.T) {
	if _, ok := ortForPlatform(); !ok {
		t.Skip("no runtime archive for this platform")
	}
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, nil)
	if err := m.Install(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		m.Cancel()
		m.mu.Lock()
		done := m.installDone
		m.mu.Unlock()
		if done != nil {
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				t.Error("install did not stop after cancellation")
			}
		}
	})
	if err := m.Install(); err == nil {
		t.Fatal("overlapping install was accepted")
	}
}

func TestRemoveWaitsForCanceledInstall(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, nil)
	installDone := make(chan struct{})
	canceled := make(chan struct{})
	m.installDone = installDone
	m.cancel = func() { close(canceled) }
	removed := make(chan error, 1)
	go func() { removed <- m.Remove() }()
	<-canceled
	select {
	case err := <-removed:
		t.Fatalf("Remove returned before install finished: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	close(installDone)
	select {
	case err := <-removed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Remove did not finish after install stopped")
	}
}

func TestShutdownWaitsForDecisionInstaller(t *testing.T) {
	m := NewManager(nil, nil)
	installDone, canceled := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-installDone:
		default:
			close(installDone)
		}
	})
	m.installDone, m.cancel = installDone, func() { close(canceled) }
	shutdownDone := make(chan struct{})
	go func() { m.BeginShutdown(); close(shutdownDone) }()
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not cancel installation")
	}
	if err := m.Load(); err == nil {
		t.Fatal("decision model loaded during shutdown")
	}
	select {
	case <-shutdownDone:
		t.Fatal("shutdown returned before installation finished")
	case <-time.After(25 * time.Millisecond):
	}
	close(installDone)
	select {
	case <-shutdownDone:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish after installation stopped")
	}
}

// blockingEvaluator stands in for a loaded model whose decision runs until
// its context ends or the test releases it.
type blockingEvaluator struct {
	started chan struct{}
	release chan struct{}
	calls   atomic.Int32
	closed  atomic.Bool
}

func newBlockingEvaluator() *blockingEvaluator {
	return &blockingEvaluator{started: make(chan struct{}, 1), release: make(chan struct{})}
}

func (e *blockingEvaluator) evaluate(ctx context.Context, req request, model string) (*ordered, error) {
	e.calls.Add(1)
	select {
	case e.started <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-e.release:
		return newOrdered(), nil
	}
}

func (e *blockingEvaluator) close()                 { e.closed.Store(true) }
func (e *blockingEvaluator) runtimeVersion() string { return "test" }

var testDecisionBody = []byte(`{"state":"Order confirmed.","questions":{"completion":{"type":"choice",` +
	`"instructions":"Did the task finish?","criteria":{"completed":"It finished.","not_completed":"It did not."}}}}`)

// Quitting during a slow decision (Compass on the CPU takes tens of seconds)
// must end it instead of holding Unload, and the companion, until it ends.
func TestShutdownEndsRunningDecision(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	m := NewManager(nil, nil)
	eng := newBlockingEvaluator()
	t.Cleanup(func() { close(eng.release) })
	m.eng, m.engSpec = eng, m.active()
	decided := make(chan error, 1)
	go func() {
		_, err := m.EvaluateJSON(context.Background(), testDecisionBody)
		decided <- err
	}()
	select {
	case <-eng.started:
	case <-time.After(5 * time.Second):
		t.Fatal("decision did not start")
	}
	unloaded := make(chan struct{})
	go func() {
		m.BeginShutdown()
		m.Unload()
		close(unloaded)
	}()
	select {
	case <-unloaded:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown waited for the running decision to finish")
	}
	if err := <-decided; !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("decision ended with %v, want ErrShuttingDown", err)
	}
	if !eng.closed.Load() {
		t.Fatal("Unload did not release the sessions")
	}
}

// A decision that arrives, or was waiting for the model, once shutdown has
// begun must not run on the loaded sessions.
func TestDecisionDuringShutdownDoesNotRun(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	m := NewManager(nil, nil)
	eng := newBlockingEvaluator()
	close(eng.release) // decisions answer at once
	m.eng, m.engSpec = eng, m.active()
	if _, err := m.EvaluateJSON(context.Background(), testDecisionBody); err != nil {
		t.Fatalf("decision before shutdown: %v", err)
	}
	m.BeginShutdown()
	if _, err := m.EvaluateJSON(context.Background(), testDecisionBody); !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("decision during shutdown returned %v, want ErrShuttingDown", err)
	}
	if n := eng.calls.Load(); n != 1 {
		t.Fatalf("loaded model ran %d decisions, want only the one before shutdown", n)
	}
}

func TestValidFileRejectsSameSizeCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "model.data")
	good := []byte("pinned model contents")
	sum := sha256.Sum256(good)
	want := hex.EncodeToString(sum[:])
	m := NewManager(nil, nil)
	bad := []byte("xinned model contents")
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if m.validFile(path, int64(len(good)), want) {
		t.Fatal("same-sized corrupt file passed checksum verification")
	}
	if err := os.WriteFile(path, good, 0o600); err != nil {
		t.Fatal(err)
	}
	if !m.validFile(path, int64(len(good)), want) {
		t.Fatal("valid file did not pass checksum verification")
	}
	// A modified cached file must be rehashed on the next status or load.
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	modified := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	if m.validFile(path, int64(len(good)), want) {
		t.Fatal("changed file reused a previous successful checksum")
	}
}

func TestORTRuntimeNeedsCompletedExtraction(t *testing.T) {
	asset, ok := ortForPlatform()
	if !ok {
		t.Skip("no runtime archive for this platform")
	}
	t.Setenv("WBC_HOME", t.TempDir())
	path := ortLibPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("complete runtime"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(nil, nil)
	if m.ortReady(asset) {
		t.Fatal("library without completed-extraction marker was accepted")
	}
	if err := m.markORT(asset); err != nil {
		t.Fatal(err)
	}
	if !m.ortReady(asset) {
		t.Fatal("marked runtime was rejected")
	}
	if err := os.WriteFile(path, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if m.ortReady(asset) {
		t.Fatal("truncated runtime was accepted")
	}
}

// The active model is the user's choice, else the default, else d1 while
// only d1 is installed.
func TestActiveModelFallsBackToInstalledD1(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, nil)
	tiny := func(s *modelSpec) {
		data := []byte(s.id + " weights")
		sum := sha256.Sum256(data)
		f := file{"model.bin", int64(len(data)), hex.EncodeToString(sum[:])}
		old := s.files
		s.files = []file{f}
		t.Cleanup(func() { s.files = old })
	}
	install := func(s *modelSpec) {
		p := s.path(s.files[0])
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s.id+" weights"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	tiny(compassSpec)
	tiny(d1Spec)
	if got := m.active(); got.id != DefaultModel {
		t.Fatalf("nothing installed: active %s, want the default", got.id)
	}
	install(d1Spec)
	if got := m.active(); got != d1Spec {
		t.Fatalf("only d1 installed: active %s, want d1", got.id)
	}
	install(compassSpec)
	if got := m.active(); got != compassSpec {
		t.Fatalf("both installed: active %s, want compass", got.id)
	}
	if err := m.SetModel(ModelD1); err != nil {
		t.Fatal(err)
	}
	if got := m.active(); got != d1Spec {
		t.Fatalf("d1 chosen: active %s", got.id)
	}
	if err := m.SetModel("bonsai"); err == nil {
		t.Fatal("an unknown model was accepted")
	}
	if err := m.RemoveModel(ModelCompass); err != nil {
		t.Fatal(err)
	}
	if m.modelInstalled(compassSpec) || !m.modelInstalled(d1Spec) {
		t.Fatal("removing the other model removed the wrong files")
	}
	if store.Get().Decision.Model != ModelD1 {
		t.Fatal("removing the other model changed the choice")
	}
}
