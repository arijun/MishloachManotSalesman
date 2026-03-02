import type { RouteResult, Stop } from '../types.ts';
import { buildAppleMapsURL } from '../io/export.ts';

function formatTime(departureTime: string, addSec: number): string {
  const [hh, mm] = departureTime.split(':').map(Number);
  const totalMin = hh * 60 + mm + Math.round(addSec / 60);
  const rh = Math.floor(totalMin / 60) % 24;
  const rm = totalMin % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const ampm = rh < 12 ? 'AM' : 'PM';
  const h12 = rh % 12 || 12;
  return `${h12}:${pad(rm)} ${ampm}`;
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderRouteList(
  listEl: HTMLOListElement,
  summaryEl: HTMLElement,
  result: RouteResult,
  departureTime: string,
  onStopClick: (index: number) => void,
): void {
  listEl.innerHTML = '';

  let cumulativeSec = 0;

  result.orderedStops.forEach((stop, i) => {
    const isFirst = i === 0;
    const isLast  = i === result.orderedStops.length - 1;
    const isDepot = isFirst || isLast;
    const isStop  = 'name' in stop;
    const s       = stop as Stop;

    const name    = isStop ? s.name : (isFirst ? 'Start' : 'End');
    const addr    = stop.normalizedAddress;
    const phone   = isStop && s.phone ? `<div class="stop-meta">${escapeHtml(s.phone)}</div>` : '';
    const notes   = isStop && s.notes ? `<div class="stop-meta"><em>${escapeHtml(s.notes)}</em></div>` : '';
    const arrival = `<div class="stop-time">${formatTime(departureTime, cumulativeSec)}</div>`;

    const appleUrl = (() => { try { return buildAppleMapsURL(stop); } catch { return ''; } })();
    const appleBtn = appleUrl && !isLast
      ? `<a href="${appleUrl}" target="_blank" class="btn-apple-maps">Nav ↗</a>`
      : '';
    const checkbox = !isDepot
      ? `<input type="checkbox" class="stop-check" title="Mark delivered" />`
      : '';

    const label = isFirst ? 'S' : isLast ? 'E' : String(i);

    const li = document.createElement('li');
    li.className = `route-stop${isDepot ? ' depot' : ''}`;
    li.dataset.index = String(i);
    li.innerHTML = `
      <div class="stop-number">${label}</div>
      <div class="stop-body">
        <div class="stop-name">${escapeHtml(name)}</div>
        <div class="stop-addr">${escapeHtml(addr)}</div>
        ${phone}${notes}${arrival}
      </div>
      <div class="stop-actions">
        ${checkbox}
        ${appleBtn}
      </div>
    `;

    // Checkbox → mark delivered
    const cb = li.querySelector<HTMLInputElement>('.stop-check');
    cb?.addEventListener('change', () => {
      li.classList.toggle('delivered', cb.checked);
    });

    // Click on body → pan map
    li.querySelector('.stop-body')?.addEventListener('click', () => onStopClick(i));

    listEl.appendChild(li);

    if (i < result.segments.length) {
      cumulativeSec += result.segments[i].durationSec;
    }
  });

  const stopCount = result.orderedStops.length - 2; // exclude depots
  summaryEl.textContent = `${stopCount} stops · ~${formatDuration(result.totalDurationSec)} total drive time`;
}
