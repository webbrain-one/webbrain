import { useEffect, useRef, useState } from 'react';
import { MdArrowForward, MdChatBubbleOutline, MdSearch, MdSmartToy } from 'react-icons/md';
import { wbT } from 'lib/wb-strings';
import { canSearch, isHandoffPending, openAskChat, pendingHandoffText, primeCurrentTab, runSearch, submitTask, whenClaimed } from './handoff';

import './taskbox.scss';

const MODES = [
  { id: 'ask', icon: MdChatBubbleOutline },
  { id: 'act', icon: MdSmartToy },
  { id: 'search', icon: MdSearch },
];

const availableModes = () => MODES.filter((mode) => mode.id !== 'search' || canSearch());

const readMode = () => {
  const saved = localStorage.getItem('taskBoxMode');
  return availableModes().some((mode) => mode.id === saved) ? saved : 'ask';
};

function TaskBox() {
  const [mode, setMode] = useState(readMode);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  // True from a successful submit until the side panel has taken the task, so a
  // second task cannot replace it while a cold panel is still starting.
  const [waiting, setWaiting] = useState(false);
  const inputRef = useRef(null);
  // Set synchronously: two submit events in the same tick both see the stale `waiting`.
  const submittingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    // After a reload an earlier task may still be waiting for the panel; keep the box
    // locked until it has been taken, like right after a submit.
    primeCurrentTab().then((tab) => {
      if (alive && tab?.id != null && isHandoffPending(tab.id)) {
        setWaiting(true);
        const adoptedText = pendingHandoffText(tab.id);
        whenClaimed(tab).then((claimed) => {
          if (!alive) return;
          setWaiting(false);
          if (claimed === false) {
            // The panel never took it: give the text back, as after a direct submit.
            setText((current) => current || adoptedText);
            setError(wbT('wb.panel_failed'));
          }
        });
      }
    });
    if (localStorage.getItem('taskBoxFocus') !== 'false') inputRef.current?.focus();
    return () => { alive = false; };
  }, []);

  const onSubmit = (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || waiting || submittingRef.current) return;
    setError('');

    // Both branches start synchronously inside the submit gesture.
    if (mode === 'search') {
      runSearch(value).catch(() => setError(wbT('wb.panel_failed')));
      return;
    }
    submittingRef.current = true;
    setWaiting(true);
    // Ask becomes a full-page chat in this tab; Act opens the side panel beside it.
    const handOver = mode === 'ask' ? openAskChat : submitTask;
    handOver({ text: value, mode })
      .then(() => {
        setText('');
        // Stays locked until the panel has taken the task.
        return whenClaimed();
      })
      .then((claimed) => {
        // The panel never took it: give the text back and say so, rather than unlocking as if it had.
        if (claimed === false) {
          setText((current) => current || value);
          setError(wbT('wb.panel_failed'));
        }
      })
      .catch(() => setError(wbT('wb.panel_failed')))
      .finally(() => {
        submittingRef.current = false;
        setWaiting(false);
        inputRef.current?.focus();
      });
  };

  return (
    <div className="taskBox">
      <form className="taskBoxForm" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          className="taskBoxInput"
          type="text"
          value={text}
          maxLength={4000}
          autoComplete="off"
          spellCheck={false}
          placeholder={wbT(`wb.placeholder_${mode}`)}
          aria-label={wbT(`wb.placeholder_${mode}`)}
          disabled={waiting}
          onChange={(event) => setText(event.target.value)}
        />
        <button className="taskBoxGo" type="submit" aria-label={wbT('wb.go')} disabled={waiting || !text.trim()}>
          <MdArrowForward />
        </button>
      </form>
      <div className="taskBoxModes" role="radiogroup">
        {availableModes().map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            className={mode === id ? 'taskBoxMode active' : 'taskBoxMode'}
            onClick={() => {
              setMode(id);
              inputRef.current?.focus();
            }}
          >
            <Icon />
            <span>{wbT(`wb.${id}`)}</span>
          </button>
        ))}
      </div>
      {mode === 'act' && (
        <span className="taskBoxHint taskBoxWarning" role="note">
          {wbT('wb.act_hint')}
        </span>
      )}
      {error && (
        <span className="taskBoxHint taskBoxError" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export default TaskBox;
