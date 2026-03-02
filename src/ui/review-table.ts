import type { Stop } from '../types.ts';
import { attachAutocomplete } from './autocomplete.ts';
import type { AutocompleteOptions } from './autocomplete.ts';

type OnSaveCallback = (stopId: string, newAddress: string) => void;


function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render the "geocoded as" sub-line beneath the address.
 */
function renderGeocodedAs(stop: Stop): string {
  if (!stop.geocodedAs) return '';
  const short = stop.geocodedAs.split(',').slice(0, 3).join(',');
  return `<div class="geocoded-as" title="${escapeHtml(stop.geocodedAs)}">Geocoded as: ${escapeHtml(short)}</div>`;
}

/**
 * Render the "original" sub-line when the displayed address differs from
 * what came from the CSV. This happens after city injection or manual edits,
 * letting drivers see the original (e.g. "4846A S Morgan St" which carries
 * unit info) even after the address was adjusted for geocoding.
 */
function renderOriginalAddr(stop: Stop): string {
  if (stop.rawAddress === stop.normalizedAddress) return '';
  return `<div class="original-addr" title="Original from CSV">Orig: ${escapeHtml(stop.rawAddress)}</div>`;
}

export function renderReviewTable(
  tbody: HTMLTableSectionElement,
  stops: Stop[],
  depot: { normalizedAddress: string } | null,
  onSave: OnSaveCallback,
  acOptions?: AutocompleteOptions,
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
        ${renderOriginalAddr(stop)}
        ${renderGeocodedAs(stop)}
        ${isFlagged ? renderInlineEdit(stop) : ''}
      </td>
      <td>${escapeHtml(stop.phone)}</td>
      <td>${escapeHtml(stop.notes)}</td>
    `;

    if (isFlagged) {
      const form = tr.querySelector<HTMLElement>('.inline-edit-form')!;
      const input = form.querySelector<HTMLInputElement>('.edit-addr-input')!;
      const saveBtn = form.querySelector<HTMLButtonElement>('.btn-save-edit')!;

      if (acOptions) attachAutocomplete(input, acOptions);

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

    // Refresh original-addr line
    const existingOrig = addrCell.querySelector('.original-addr');
    const newOrigHtml = renderOriginalAddr(stop);
    if (existingOrig) existingOrig.outerHTML = newOrigHtml || '';
    else if (newOrigHtml) addrText?.insertAdjacentHTML('afterend', newOrigHtml);

    // Refresh geocoded-as line
    const existingGeo = addrCell.querySelector('.geocoded-as');
    const newGeoHtml = renderGeocodedAs(stop);
    if (existingGeo) existingGeo.outerHTML = newGeoHtml || '';
    else if (newGeoHtml) addrCell.querySelector('.original-addr, .addr-text')
      ?.insertAdjacentHTML('afterend', newGeoHtml);
  }

}
