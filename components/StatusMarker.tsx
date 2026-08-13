import { STATUS_LABEL, type DisplayStatus } from '@/lib/jobView';

/**
 * A dot and a label in one colour. This is the list form of a status.
 *
 * The filled pill below is deliberately rarer: it belongs to the detail header,
 * where a job is the only thing on screen. Using it in a list would put four
 * tinted badges in a column and make every card shout.
 */
export function StatusMarker({ status }: { status: DisplayStatus }) {
  return (
    <span className="marker" data-tone={status} data-live={status === 'working'}>
      <span className="markerDot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function StatusBadge({ status }: { status: DisplayStatus }) {
  return (
    <span className="badge" data-tone={status}>
      <span
        className="markerDot"
        style={{
          background:
            status === 'done'
              ? 'var(--success)'
              : status === 'failed'
                ? 'var(--failure)'
                : 'var(--warning)',
        }}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}
