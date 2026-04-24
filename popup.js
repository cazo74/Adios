/**
 * AD'IOS — popup.js v2.0
 * Lit chrome.storage.local et affiche les stats en temps réel.
 */
;(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const elSkipped      = $('stat-skipped');
  const elSession      = $('stat-session');
  const elSessionLabel = $('stat-session-label');
  const elBadge        = $('status-badge');
  const elLogList      = $('log-list');
  const elClearLog     = $('clear-log');

  // ─── Stratégie → couleur dot ─────────────────────────────────────────────
  function typeFromMsg(msg = '') {
    const m = msg.toLowerCase();
    if (m.includes('skip button'))  return 'success';
    if (m.includes('overlay'))      return 'success';
    if (m.includes('fast-forward')) return 'warn';
    if (m.includes('turbo'))        return 'warn';
    if (m.includes('rechargement')) return 'error';
    return 'success';
  }

  // ─── Chargement ──────────────────────────────────────────────────────────
  function loadData() {
    chrome.storage.local.get(
      ['totalSkipped', 'sessionStart', 'logs'],
      ({ totalSkipped = 0, sessionStart = null, logs = [] }) => {

        // Compteur
        elSkipped.textContent = totalSkipped;

        // Durée session
        if (sessionStart) {
          const mins = Math.floor((Date.now() - sessionStart) / 60000);
          if (mins < 60) {
            elSession.textContent      = `${mins}`;
            elSessionLabel.textContent = 'min session';
          } else {
            const h = Math.floor(mins / 60), m = mins % 60;
            elSession.textContent      = `${h}h${String(m).padStart(2,'0')}`;
            elSessionLabel.textContent = 'session';
          }
        }

        // Journal
        renderLogs(logs);
      }
    );
  }

  function renderLogs(logs) {
    if (!logs.length) {
      elLogList.innerHTML = '<div class="log-empty">En attente de publicités…</div>';
      return;
    }

    elLogList.innerHTML = [...logs]
      .reverse()
      .slice(0, 25)
      .map(({ ts, msg, type }) => {
        const t = type || typeFromMsg(msg);
        return `<div class="log-item ${t}">
          <span class="log-time">${formatTime(ts)}</span>
          <span class="log-msg">${esc(msg)}</span>
        </div>`;
      })
      .join('');
  }

  function formatTime(ts) {
    if (!ts) return '--:--';
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, '0'))
      .join(':');
  }

  function esc(s = '') {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ─── Badge YouTube actif / pas ───────────────────────────────────────────
  function checkTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.url?.includes('youtube.com')) {
        elBadge.textContent = 'HORS YT';
        elBadge.classList.add('inactive');
      }
    });
  }

  // ─── Effacer le journal ───────────────────────────────────────────────────
  elClearLog.addEventListener('click', () => {
    chrome.storage.local.set({ logs: [] }, loadData);
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  loadData();
  checkTab();
  setInterval(loadData, 2000);

})();
