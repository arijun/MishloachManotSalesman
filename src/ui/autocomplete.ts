/**
 * Address autocomplete using Photon (Komoot) — no API key required.
 * Attaches to any <input> element and shows a fixed-positioned dropdown.
 *
 * Supports a `getBias` option: a callback returning {lat, lng} that is passed
 * to Photon as a soft location bias on every request. When set, Photon ranks
 * nearby results higher without hard-filtering distant ones.
 */

import type { Coords } from '../types.ts';

const PHOTON_URL  = 'https://photon.komoot.io/api/';
const DEBOUNCE_MS = 300;
const MIN_CHARS   = 4;

export interface AutocompleteOptions {
  /** Called when the user selects a suggestion. Receives the canonical address
   *  string and, when available, the coordinates from Photon's geometry. */
  onSelect?: (address: string, coords?: Coords) => void;
  /** Return current bias coordinates for every autocomplete request.
   *  Photon uses these as a soft proximity hint — nearby results are ranked
   *  higher but far-away results are not hard-filtered. */
  getBias?: () => Coords | null;
}

interface PhotonProperties {
  housenumber?: string;
  street?: string;
  name?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  type?: string;
}

interface Suggestion {
  address: string;   // canonical full address filled into the input on select
  line1: string;     // house + street (shown in dropdown)
  line2: string;     // city, state, zip (shown muted)
  coords?: Coords;   // from Photon geometry — passed to onSelect
}

function buildSuggestion(
  props: PhotonProperties,
  geometry: [number, number], // [lng, lat]
): Suggestion | null {
  const streetPart =
    props.housenumber && props.street
      ? `${props.housenumber} ${props.street}`
      : props.street ?? props.name ?? '';
  if (!streetPart) return null;

  const cityParts = [props.city, props.state, props.postcode].filter(Boolean);
  const line1     = streetPart;
  const line2     = cityParts.join(', ');
  const address   = [streetPart, ...cityParts].join(', ');
  const coords: Coords = { lat: geometry[1], lng: geometry[0] };
  return { address, line1, line2, coords };
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Attach autocomplete behaviour to an input element.
 * Returns a cleanup function that removes event listeners and the dropdown.
 */
export function attachAutocomplete(
  input: HTMLInputElement,
  options?: AutocompleteOptions,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let dropdown: HTMLUListElement | null = null;
  let suggestions: Suggestion[] = [];
  let activeIndex = -1;
  let destroyed = false;

  // ── Dropdown lifecycle ──────────────────────────────────────────────

  function openDropdown(items: Suggestion[]): void {
    closeDropdown();
    if (items.length === 0 || destroyed) return;
    suggestions = items;
    activeIndex = -1;

    dropdown = document.createElement('ul');
    dropdown.className = 'ac-dropdown';
    dropdown.setAttribute('role', 'listbox');

    items.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'ac-item';
      li.setAttribute('role', 'option');
      li.innerHTML =
        `<span class="ac-line1">${escHtml(s.line1)}</span>` +
        (s.line2 ? `<span class="ac-line2">${escHtml(s.line2)}</span>` : '');
      li.addEventListener('mousedown', e => {
        e.preventDefault(); // prevent blur before click fires
        selectItem(i);
      });
      dropdown!.appendChild(li);
    });

    positionDropdown();
    document.body.appendChild(dropdown);
  }

  function positionDropdown(): void {
    if (!dropdown) return;
    const r = input.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top   = `${r.bottom + 2}px`;
    dropdown.style.left  = `${r.left}px`;
    dropdown.style.width = `${r.width}px`;
  }

  function closeDropdown(): void {
    dropdown?.remove();
    dropdown = null;
    suggestions = [];
    activeIndex = -1;
  }

  function selectItem(i: number): void {
    const s = suggestions[i];
    if (!s) return;
    input.value = s.address;
    options?.onSelect?.(s.address, s.coords);
    closeDropdown();
  }

  function setActive(i: number): void {
    activeIndex = i;
    dropdown?.querySelectorAll('.ac-item').forEach((el, j) =>
      el.classList.toggle('active', j === activeIndex),
    );
  }

  // ── Fetch ───────────────────────────────────────────────────────────

  async function fetchSuggestions(q: string): Promise<void> {
    if (q.length < MIN_CHARS || destroyed) { closeDropdown(); return; }
    try {
      const params = new URLSearchParams({ q, limit: '5', lang: 'en' });

      // Apply location bias if available
      const bias = options?.getBias?.();
      if (bias) {
        params.set('lat', String(bias.lat));
        params.set('lon', String(bias.lng));
      }

      const res = await fetch(`${PHOTON_URL}?${params}`);
      if (!res.ok || destroyed) return;

      const data = await res.json() as {
        features: { properties: PhotonProperties; geometry: { coordinates: [number, number] } }[];
      };

      const items = (data.features ?? [])
        .map(f => buildSuggestion(f.properties, f.geometry.coordinates))
        .filter((s): s is Suggestion => s !== null);

      openDropdown(items);
    } catch { /* network errors are silent */ }
  }

  // ── Event handlers ──────────────────────────────────────────────────

  function onInput(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void fetchSuggestions(input.value.trim()), DEBOUNCE_MS);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!dropdown) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive(Math.min(activeIndex + 1, suggestions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive(Math.max(activeIndex - 1, 0));
        break;
      case 'Enter':
        if (activeIndex >= 0) { e.preventDefault(); selectItem(activeIndex); }
        break;
      case 'Escape':
        closeDropdown();
        break;
    }
  }

  function onBlur(): void {
    setTimeout(closeDropdown, 150);
  }

  function onScroll(): void {
    positionDropdown();
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  input.addEventListener('blur', onBlur);
  window.addEventListener('scroll', onScroll, { passive: true });

  // ── Cleanup ─────────────────────────────────────────────────────────

  return () => {
    destroyed = true;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
    input.removeEventListener('blur', onBlur);
    window.removeEventListener('scroll', onScroll);
    closeDropdown();
  };
}
