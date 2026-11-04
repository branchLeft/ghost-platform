// The part of Ghost's container log that belongs to one failed content import.
// Ghost runs an import as a background job and logs the failure; the reason is
// in the lines that follow the marker. The marker may appear more than once in
// a container's life, so the section is chosen by how many failures were
// already logged before this import started, not by position in the log.
export function importFailureSection(log, marker, failuresBefore) {
  let start = -1;
  let from = 0;
  for (let seen = 0; seen <= failuresBefore; seen += 1) {
    start = log.indexOf(marker, from);
    if (start === -1) return '';
    from = start + marker.length;
  }
  const next = log.indexOf(marker, from);
  return log.slice(start, next === -1 ? undefined : next);
}
