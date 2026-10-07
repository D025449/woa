export class MicroIntervalWorkerClient {
  constructor() {
    this.worker = null;
    this.workout = null;
    this.requests = new Map();
    this.nextRequestId = 0;
  }
  scan(workout, range = {}) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./microinterval-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const request = this.requests.get(data.requestId);
        if (!request) return;
        this.requests.delete(data.requestId);
        if (data.error) request.reject(new Error(data.error)); else request.resolve(data);
      };
      this.worker.onerror = (event) => {
        for (const request of this.requests.values()) request.reject(new Error(event.message || 'Worker failed'));
        this.requests.clear();
        this.worker.terminate(); this.worker = null; this.workout = null;
      };
    }
    if (this.workout !== workout) {
      const buffer = workout.toBuffer().slice(0);
      this.worker.postMessage({ type: 'init', buffer }, [buffer]);
      this.workout = workout;
    }
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.requests.set(requestId, { resolve, reject });
      this.worker.postMessage({ type: 'scan', requestId, ...range });
    });
  }
}

export async function saveMicroIntervalChanges(workout, changes) {
  const response = await fetch(`/files/workouts/${encodeURIComponent(workout.id)}/segments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments: changes })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Save failed (${response.status})`);
  const changedIds = new Set(changes.filter((segment) => segment.rowstate !== 'CRE').map((segment) => String(segment.id)));
  workout.segments = (workout.segments || []).filter((segment) => segment.isGPSSegment || !changedIds.has(String(segment.id)));
  workout.segments.push(...payload.segments.map((segment) => ({ ...segment, rowstate: 'DB', isGPSSegment: false })));
  return payload.segments;
}

export function microIntervalScanChanges(workout, blocks) {
  const existing = (workout.segments || []).filter((segment) => !segment.isGPSSegment && segment.structure_kind === 'microintervals');
  const manual = existing.filter((segment) => segment.segmenttype === 'manual');
  const creates = blocks.filter((block) => !manual.some((segment) => block.start_offset <= segment.end_offset && block.end_offset >= segment.start_offset));
  return [
    ...existing.filter((segment) => segment.segmenttype === 'auto').map((segment) => ({ ...segment, rowstate: 'DEL' })),
    ...creates.map((block) => ({ ...block, rowstate: 'CRE' }))
  ];
}
