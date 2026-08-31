// Status -> color/badge mapping, shared by every chart and table so the
// same status always reads as the same color everywhere in the app.
// Colors are CSS custom properties defined in style.css (see the dataviz
// skill's palette.md — good/critical are the reserved status colors;
// In Progress/Pending use the categorical accent and muted ink instead of
// forcing them into "warning/serious", which don't fit a normal workflow state).

export const STATUS_ORDER = ['Pending', 'In Progress', 'Blocked', 'Done'];

export const STATUS_VAR = {
  Pending: '--status-pending',
  'In Progress': '--status-in-progress',
  Done: '--status-done',
  Blocked: '--status-blocked',
};

export const STATUS_BADGE_CLASS = {
  Pending: 'badge badge-pending',
  'In Progress': 'badge badge-in-progress',
  Done: 'badge badge-done',
  Blocked: 'badge badge-blocked',
};

export function statusColor(status) {
  const varName = STATUS_VAR[status] || '--text-muted';
  return `var(${varName})`;
}

export function statusBadgeClass(status) {
  return STATUS_BADGE_CLASS[status] || 'badge';
}
