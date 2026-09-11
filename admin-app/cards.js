/* Project and revision cards, shared by /admin and /browse.
 *
 * Both pages render the same list of published work; they differ only in which
 * buttons a card carries. That difference is one `controls` flag rather than two
 * copies of the markup, because the two lists showing a revision differently —
 * one collapsing notes, one not; one showing provenance, one forgetting to — is
 * exactly the drift that copying six functions into a second page produces.
 *
 * `controls: true` adds the mutating actions (rename, notes, delete). Nothing here
 * enforces anything: the API refuses an edit from a read-only account whatever the
 * page renders. Withholding the buttons is so a reader is not shown a control that
 * cannot work.
 *
 * Vanilla ES module, no build step.
 */
import { shareUrl, escapeHtml, fmtDate, notePreview } from '/app/app.js';

export function fmtBytes(n) {
  if (!n) return '';
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/**
 * A revision's state, when it is worth saying. Only /admin ever sees one of
 * these: `/browse` is served published revisions only, so `status` is absent from
 * its payload entirely and this returns nothing.
 */
export function statusPill(rev) {
  if (!rev.status || rev.status === 'ready') return '';
  const kind = rev.status === 'error' ? 'err' : 'warn';
  const title = rev.error ? ` title="${escapeHtml(rev.error)}"` : '';
  return ` <span class="pill ${kind}"${title}>${escapeHtml(rev.status)}</span>`;
}

// Provenance is shown but never edited, on either page: it is a mechanical claim
// about bytes that are immutable, so a hand-typed correction would be an assertion
// nobody could check against the model. The remedy for a wrong one is a new
// revision, the same as for wrong geometry. Notes and the title stay editable (on
// /admin) because they are prose, meant to be revised.
export function sourceLine(rev) {
  const s = rev.source;
  if (!s) return '';
  const where = [s.repo, s.path].filter(Boolean).join('/');
  const parts = [
    where,
    s.commit ? s.commit.slice(0, 12) : '',
    s.dirty ? 'dirty' : '',
    s.build || '',
  ].filter(Boolean);
  if (!parts.length) return '';
  const full = s.recreate || parts.join(' · ');
  return `<div class="meta mono" title="${escapeHtml(full)}">built from ${escapeHtml(parts.join(' · '))}</div>`;
}

/**
 * A revision's notes, collapsed to one line when they are long or tall enough to
 * be worth it (notePreview decides). Both forms go into the DOM and CSS switches
 * between them, so expanding is a class flip with nothing to re-fetch and no state
 * to keep outside the element itself.
 *
 * Note the absence of whitespace between the two spans: `.note` is pre-wrap, so
 * indentation inside it would render as a visible gap.
 */
export function noteBlock(rev) {
  const text = (rev.notes || '').trim();
  if (!text) return '<div class="note">No notes.</div>';
  const preview = notePreview(text);
  if (preview === null) return `<div class="note">${escapeHtml(text)}</div>`;
  return `<div class="note collapsed"><span class="note-preview">${escapeHtml(preview)}</span>`
    + `<span class="note-full">${escapeHtml(text)}</span></div>`
    + `<button class="note-toggle" data-act="toggle-note" aria-expanded="false">Show more</button>`;
}

export function revisionRow(cfg, project, rev, { controls = false } = {}) {
  const url = shareUrl(cfg, project.slug, rev.rev);
  // A revision that never finished processing has no page to link to. `/browse`
  // never receives one, so there the link is always live.
  const link = !rev.status || rev.status === 'ready'
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="mono">/${escapeHtml(project.slug)}/${rev.rev}</a>`
    : `<span class="mono muted">/${escapeHtml(project.slug)}/${rev.rev}</span>`;
  const comments = rev.commentCount
    ? `<span class="pill">${rev.commentCount} comment${rev.commentCount === 1 ? '' : 's'}</span>`
    : '';
  const actions = controls
    ? `<button class="btn tiny secondary" data-act="notes" data-slug="${escapeHtml(project.slug)}" data-rev="${rev.rev}">Notes</button>
          <button class="btn tiny danger" data-act="del-rev" data-slug="${escapeHtml(project.slug)}" data-rev="${rev.rev}">Delete</button>`
    : '';
  return `<li>
        <div class="revhead">
          <strong>Rev ${rev.rev}</strong>${statusPill(rev)}
          ${link}
          <span class="spacer"></span>
          ${comments}
          <button class="btn tiny secondary" data-act="copy" data-url="${escapeHtml(url)}">Copy</button>
          ${actions}
        </div>
        ${noteBlock(rev)}
        <div class="meta mono">${escapeHtml(fmtDate(rev.publishedAt || rev.reservedAt))} · ${escapeHtml(fmtBytes(rev.bytes))}</div>
        ${sourceLine(rev)}
      </li>`;
}

/**
 * The revision list, plus what it is a window onto. `revisionCount` is every
 * revision the project has; only the newest few come down with the page, so a
 * long-running project does not make either page expensive to load.
 */
export function revisionList(cfg, project, opts = {}) {
  const shown = project.revisions.length;
  const total = project.revisionCount ?? shown;
  const rows = project.revisions.map((r) => revisionRow(cfg, project, r, opts)).join('');
  const label = total === shown
    ? `${total} revision${total === 1 ? '' : 's'}`
    : `${shown} of ${total} revisions`;
  const showAll = total > shown
    ? `<button class="btn tiny secondary" data-act="all-revs" data-slug="${escapeHtml(project.slug)}">Show all ${total}</button>`
    : '';
  return `<details${total <= 3 ? ' open' : ''} data-project="${escapeHtml(project.slug)}">
          <summary>${label}</summary>
          <ul class="revs">${rows}</ul>
          ${showAll ? `<div class="more">${showAll}</div>` : ''}
        </details>`;
}

export function projectCard(cfg, project, opts = {}) {
  const latestUrl = shareUrl(cfg, project.slug);
  const count = project.revisionCount ?? project.revisions.length;
  const actions = opts.controls
    ? `<button class="btn tiny secondary" data-act="title" data-slug="${escapeHtml(project.slug)}">Rename</button>
          <button class="btn tiny danger" data-act="del-project" data-slug="${escapeHtml(project.slug)}">Delete all</button>`
    : '';
  return `<div class="card" data-card="${escapeHtml(project.slug)}">
        <div class="row">
          <div>
            <div class="title">${escapeHtml(project.title || project.slug)}</div>
            <div class="meta mono">${escapeHtml(project.slug)} · ${count} revision${count === 1 ? '' : 's'}${
              project.latest ? ` · latest is rev ${project.latest}` : ' · nothing published'
            }</div>
          </div>
          <div class="spacer"></div>
          <a class="btn tiny secondary" href="${escapeHtml(latestUrl)}" target="_blank" rel="noopener">Open latest</a>
          <button class="btn tiny secondary" data-act="copy" data-url="${escapeHtml(latestUrl)}">Copy</button>
          ${actions}
        </div>
        ${revisionList(cfg, project, opts)}
      </div>`;
}

/** Show "20 of 63" and the Load more button, or hide the row when done. */
export function updateMore(node, countNode, page, noun) {
  const done = page.loaded >= page.total;
  node.classList.toggle('hidden', done);
  countNode.textContent = done ? '' : `Showing ${page.loaded} of ${page.total} ${noun}`;
}

/**
 * Swap one card's revision list for its full one, in place. Shared because both
 * pages offer "Show all N revisions" and both must leave every other card's
 * window alone while doing it.
 */
export function replaceRevisionList(cfg, container, project, opts = {}) {
  const card = container.querySelector(`[data-card="${CSS.escape(project.slug)}"]`);
  const details = card?.querySelector('details');
  if (!details) return false;
  details.outerHTML = revisionList(cfg, project, opts);
  card.querySelector('details').open = true;
  return true;
}
