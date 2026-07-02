(async () => {
  const status = document.getElementById('status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    status.textContent = 'Permission granted!';
    status.className = 'success';
    await chrome.runtime.sendMessage({ type: 'mic-permission-granted' });
    window.close();
  } catch {
    status.textContent = 'Microphone was denied. You can allow it in the extension\'s Site settings.';
    status.className = 'error';
    await chrome.runtime.sendMessage({ type: 'mic-permission-denied' });
  }
})();
