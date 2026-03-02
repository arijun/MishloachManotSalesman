import type { Stop } from '../types.ts';

type OnSaveCallback = (stopId: string, newAddress: string) => void;

const STATUS_CHIP: Record<string, string> = {
  ok:           '<span class="chip chip-ok">OK</span>',
  pending:      '<span class="chip chip-pending">Pending…</span>',
  'not-found':  '<span class="chip chip-error">Not found</span>',
  outlier:      '<span class="chip chip-warn">Outlier</span>',
  'user-edited':'<span class="chip chip-edited">Edited</span>',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render the "geocoded as" sub-line beneath the address.
 * Only shown when the geocoder returned a displayName. Styled muted so it
 * doesn't compete with the address text, but visible enough for users to
 * notice if the geocoder resolved to something unexpected.
 */
function renderGeocodedAs(stop: Stop): string {
  if (!stop.geocodedAs) return '';
  // Truncate very long display names (Nominatim returns full hierarchy)
  const short = stop.geocodedAs.split(',').slice(0, 3).join(',');
  return `<div class="geocoded-as" title="${escapeHtml(stop.geocodedAs)}">
    Geocoded as: ${escapeHtml(short)}
  </div>`;
}

export function renderReviewTable(
  tbody: HTMLTableSectionElement,
  stops: Stop[],
  depot: { normalizedAddress: string } | null,
  onSave: OnSaveCallback,
): void {
  tbody.innerHTML = '';

  // Depot row (non-editable)
  if (depot) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>S</td>
      <td><strong>Start</strong></td>
      <td>${escapeHtml(depot.normalizedAddress)}</td>
      <td>—</td>
      <td>—</td>
      <td><span class="chip chip-ok">Depot</span></td>
    `;
    tbody.appendChild(tr);
  }

  stops.forEach((stop, i) => {
    const isFlagged = stop.status === 'not-found' || stop.status === 'outlier';
    const tr = document.createElement('tr');
    tr.dataset.stopId = stop.id;
    if (isFlagged) tr.classList.add('flagged');

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(stop.name)}</td>
      <td class="addr-cell">
        <span class="addr-text">${escapeHtml(stop.normalizedAddress)}</span>
        ${renderGeocodedAs(stop)}
        ${isFlagged ? renderInlineEdit(stop) : ''}
      </td>
      <td>${escapeHtml(stop.phone)}</td>
      <td>${escapeHtml(stop.notes)}</td>
      <td>${STATUS_CHIP[stop.status] ?? ''}</td>
    `;

    if (isFlagged) {
      const form = tr.querySelector<HTMLElement>('.inline-edit-form')!;
      const input = form.querySelector<HTMLInputElement>('.edit-addr-input')!;
      const saveBtn = form.querySelector<HTMLButtonElement>('.btn-save-edit')!;

      saveBtn.addEventListener('click', () => {
        const val = input.value.trim();
        if (val) onSave(stop.id, val);
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = input.value.trim();
          if (val) onSave(stop.id, val);
        }
      });
    }

    tbody.appendChild(tr);
  });
}

function renderInlineEdit(stop: Stop): string {
  return `
    <div class="inline-edit-form">
      <input
        class="edit-addr-input"
        type="text"
        value="${escapeHtml(stop.normalizedAddress)}"
        placeholder="Enter corrected address"
      />
      <div class="inline-edit-actions">
        <button class="btn btn-sm btn-primary btn-save-edit">Save &amp; re-geocode</button>
      </div>
    </div>
  `;
}

/** Update a single row's status chip, address text, and geocodedAs after a re-geocode. */
export function updateTableRow(tbody: HTMLTableSectionElement, stop: Stop): void {
  const tr = tbody.querySelector<HTMLTableRowElement>(`[data-stop-id="${stop.id}"]`);
  if (!tr) return;

  const isFlagged = stop.status === 'not-found' || stop.status === 'outlier';
  tr.classList.toggle('flagged', isFlagged);

  const addrCell = tr.querySelector<HTMLElement>('.addr-cell');
  if (addrCell) {
    const addrText = addrCell.querySelector<HTMLElement>('.addr-text');
    if (addrText) addrText.textContent = stop.normalizedAddress;

    // Update or insert geocodedAs line
    let geocodedEl = addrCell.querySelector<HTMLElement>('.geocoded-as');
    const newGeoHtml = renderGeocodedAs(stop);
    if (geocodedEl) {
      geocodedEl.outerHTML = newGeoHtml;
    } else if (newGeoHtml) {
      addrText?.insertAdjacentHTML('afterend', newGeoHtml);
    }
  }

  const statusCell = tr.children[5] as HTMLTableCellElement;
  statusCell.innerHTML = STATUS_CHIP[stop.status] ?? '';
}
