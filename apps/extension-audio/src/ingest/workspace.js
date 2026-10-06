/**
 * workspace.js — which IronMemo workspace a recording is created in.
 *
 * The web app resolves its active workspace with this chain (@stapel/workspaces-react 0.19.1,
 * dist/model/selection.js, read 2026-10-05): explicit pick → `?workspace=` URL → its own
 * localStorage pointer → preferred_workspace_id → default_workspace_id → the first row of type
 * `personal` → the first row. The extension has no URL and no picker, so it starts at
 * preferred_workspace_id. A pick in the web app's switcher also writes preferred_workspace_id on
 * the server (`switchTo` → PUT me/preferred-workspace), so a choice made there reaches this chain.
 *
 * stapel-workspaces 0.33.0 (dto.py, WorkspaceListResponse) fixes the order of the two ids: "a
 * client resolves preferred first and the instance default only after it". Both arrive as "" when
 * unset or when the membership behind them is not active. The list itself is ordered by the server
 * (views.py:555 `-last_accessed_at, -invited_at`; PostgreSQL puts NULLs FIRST in a DESC sort, so a
 * never-opened membership comes before an opened one). Both clients apply the same tail of the chain
 * to the same list. They can still land on different rows: the web app's three first steps (explicit
 * pick, URL, its localStorage pointer) are invisible here, its PUT of the preference is
 * fire-and-forget, and the order moves whenever a workspace is opened (`GET <id>/` stamps
 * last_accessed_at, which dto.py:84 calls telemetry, not a choice). Panel P300-5b, 2026-10-06.
 *
 * Production 2026-10-05: an account with four `work` and two `personal` workspaces and both ids
 * empty. Before this module the extension refused such accounts ("Several workspaces and no
 * default"), while the web app opened the first personal row.
 */

/** @returns {{id: string, source: string, type: string|null, name: string|null, count: number} | null} */
export function pickWorkspace(data) {
  const rows = (Array.isArray(data?.workspaces) ? data.workspaces : [])
    .filter((w) => w && w.id != null && String(w.id) !== '');
  if (!rows.length) return null;
  const hit = (w, source) => ({
    id: String(w.id), source,
    type: typeof w.type === 'string' ? w.type : null,
    name: typeof w.name === 'string' && w.name.trim() ? w.name.trim().slice(0, 120) : null,
    count: rows.length,
  });
  const member = (id) => (typeof id === 'string' && id ? rows.find((w) => String(w.id) === id) ?? null : null);
  const preferred = member(data?.preferred_workspace_id);
  if (preferred) return hit(preferred, 'preference');
  const instance = member(data?.default_workspace_id);
  if (instance) return hit(instance, 'instance-default');
  const personal = rows.find((w) => w.type === 'personal');
  if (personal) return hit(personal, 'personal');
  return hit(rows[0], 'positional');
}
