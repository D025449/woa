import Workout from '../../shared/Workout.js';
import { detectMicroIntervalBlocks, workoutPhaseMetrics } from '../../shared/MicroIntervalDetector.js';

let workout = null;
self.onmessage = ({ data }) => {
  if (data.type === 'init') { workout = Workout.fromBuffer(data.buffer); return; }
  const started = performance.now();
  try {
    if (!workout) throw new Error('Workout not loaded');
    const blocks = detectMicroIntervalBlocks({ recordCount: workout.length,
      powerAtIndex: (index) => workout.getPowerAt(index), metrics: workoutPhaseMetrics(workout),
      start: data.start ?? 0, end: data.end ?? workout.length });
    self.postMessage({ requestId: data.requestId, blocks, elapsedMs: performance.now() - started });
  } catch (error) {
    self.postMessage({ requestId: data.requestId, error: error.message });
  }
};
