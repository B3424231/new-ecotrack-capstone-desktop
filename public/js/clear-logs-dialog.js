/* Accessible native-dialog shell; the caller provides the existing clear operation. */
(function(root) {
  'use strict';
  const bindings = new WeakMap();
  function attach(trigger, onClear) {
    if (bindings.has(trigger)) return bindings.get(trigger);
    const dialog = root.document.getElementById('clearLogsDialog');
    if (!dialog || typeof dialog.showModal !== 'function') { trigger.disabled = true; return null; }
    const get = id => root.document.getElementById(id);
    const cancel = get('clearLogsCancel'), close = get('clearLogsClose'), confirm = get('clearLogsConfirm');
    const title = get('clearLogsTitle'), description = get('clearLogsDescription'), feedback = get('clearLogsFeedback');
    let phase = 'confirm';
    const setPhase = value => {
      phase = value; dialog.dataset.phase = value;
      const busy = value === 'busy';
      dialog.setAttribute('aria-busy', String(busy));
      trigger.disabled = busy; cancel.disabled = busy; close.disabled = busy; confirm.disabled = busy;
      cancel.hidden = value === 'success'; get('clearLogsWarning').hidden = value === 'success';
      get('clearLogsConfirmLabel').textContent = busy ? 'Clearing...' : value === 'success' ? 'Done' : value === 'error' ? 'Try again' : 'Clear all logs';
    };
    const dismiss = () => { if (phase !== 'busy' && dialog.open) dialog.close(); };
    const open = () => {
      if (dialog.open || phase === 'busy') return;
      setPhase('confirm'); feedback.hidden = true; feedback.textContent = '';
      feedback.setAttribute('role','status'); feedback.setAttribute('aria-live','polite');
      title.textContent = 'Clear all logs?';
      description.textContent = 'Permanently remove telemetry history and daily operating logs. This will also reset the analytics audit.';
      dialog.showModal(); cancel.focus({preventScroll:true});
    };
    trigger.addEventListener('click',open);
    cancel.addEventListener('click',dismiss); close.addEventListener('click',dismiss);
    dialog.addEventListener('cancel',event => { if (phase === 'busy') event.preventDefault(); });
    dialog.addEventListener('close',() => { trigger.disabled = false; trigger.focus({preventScroll:true}); });
    dialog.addEventListener('click',event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
    });
    confirm.addEventListener('click',async () => {
      if (phase === 'busy') return;
      if (phase === 'success') { dismiss(); return; }
      setPhase('busy'); feedback.hidden = false;
      feedback.setAttribute('role','status'); feedback.setAttribute('aria-live','polite');
      feedback.textContent = 'Clearing history. Keep this window open until the action completes.';
      try {
        await onClear();
        setPhase('success');
        title.textContent = 'Logs cleared';
        description.textContent = 'Telemetry history and daily operating logs have been cleared. The analytics audit has been reset.';
        feedback.textContent = 'The analytics page has been refreshed.';
        confirm.focus({preventScroll:true});
      } catch (error) {
        setPhase('error'); feedback.hidden = false;
        feedback.setAttribute('role','alert'); feedback.setAttribute('aria-live','assertive');
        feedback.textContent = error?.message || 'Could not complete this action. Please try again.';
        cancel.focus({preventScroll:true});
      }
    });
    const controller = {open,dismiss};
    bindings.set(trigger,controller);
    return controller;
  }
  root.EcoTrackClearLogsDialog = {attach};
})(typeof window === 'undefined' ? globalThis : window);
