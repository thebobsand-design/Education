(() => {
  'use strict';

  // Path of the launcher page on this same server. The page itself is not built yet,
  // so pressing the trigger opens a blank frame showing a 404 until it exists.
  const LAUNCHER_PATH = '/launcher.html';

  // Title and icon shown on the new tab.
  const TAB_TITLE = 'Study Hub';
  const TAB_ICON =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230f766e'/%3E%3Cpath d='M16 46V20l16 18 16-18v26' fill='none' stroke='white' stroke-width='6' stroke-linejoin='round' stroke-linecap='round'/%3E%3C/svg%3E";

  // Trigger: Shift + Q
  const TRIGGER_CODE = 'KeyQ';

  const notice = document.getElementById('notice');
  let noticeTimer = 0;

  function showNotice(text) {
    if (!notice) return;
    notice.textContent = text;
    notice.classList.add('show');
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => notice.classList.remove('show'), 4500);
  }

  function isTypingTarget(el) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function openLauncher() {
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      showNotice('Pop-up blocked. Allow pop-ups for this site, then try again.');
      return;
    }

    const doc = tab.document;
    doc.title = TAB_TITLE;

    const icon = doc.createElement('link');
    icon.rel = 'icon';
    icon.href = TAB_ICON;
    doc.head.appendChild(icon);

    const style = doc.createElement('style');
    style.textContent =
      'html,body{margin:0;height:100%;background:#fff;overflow:hidden}' +
      'iframe{position:fixed;inset:0;width:100%;height:100%;border:0}';
    doc.head.appendChild(style);

    const frame = doc.createElement('iframe');
    frame.src = new URL(LAUNCHER_PATH, window.location.origin).href;
    frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write; gamepad');
    frame.setAttribute('allowfullscreen', '');
    doc.body.appendChild(frame);
  }

  window.addEventListener('keydown', (event) => {
    if (event.code !== TRIGGER_CODE || !event.shiftKey) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    openLauncher();
  });
})();
