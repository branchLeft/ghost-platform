# refusingDrainSource.ts

## refusingDrainSource

The `DrainSource` seam, filled with the final answer rather than a
placeholder: this endpoint never carries anything.

- **Mail** leaves a demo host from the mail queue itself. The operations
  host dials in and collects it directly, then submits it onward; the demo
  service is not on that path (the owner's ruling on the mail drain, and
  the design's later ruling that the operations host reaches each queue
  through its own tunnel).
- **Media hashes** have no producer that hands them to this service. The
  safety service dials into the host through its own local socket instead.

So `poll()` rejects at once with a message saying so. `app.ts#handleDrain`
treats a rejection as a source failure: it logs the message to the journal
and answers `502 {"error":"drain source unavailable"}`. That is the open
refusal: the caller gets an error, never an empty payload that could be
read as "the queue is empty".

It rejects immediately rather than waiting out the long-poll, so a caller
cannot hold a request open against a source that will never answer.
