import { buildMicroIntervalBlock, microIntervalPatternLabel, summarizeMicroIntervalBlock, workoutPhaseMetrics } from '../../shared/MicroIntervalDetector.js';
import { saveMicroIntervalChanges } from './microinterval-client.js';
import { createTranslator } from './i18n.js';

export function parseSegmentTime(value) {
  const parts = String(value).trim().split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+$/u.test(part))) throw new Error('Invalid time');
  if (parts.slice(1).some((part) => Number(part) >= 60)) throw new Error('Invalid time');
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (!Number.isSafeInteger(seconds)) throw new Error('Invalid time');
  return seconds;
}

function formatTime(value) {
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export class MicroIntervalEditor {
  constructor(worker, chart, onSaved) {
    this.worker = worker; this.chart = chart; this.onSaved = onSaved;
    this.t = createTranslator('dashboardNewPage');
  }
  open(workout, range, existing = null, kind = 'microintervals') {
    this.dialog?.close();
    this.workout = workout; this.existing = existing; this.range = range; this.customDurations = null;
    const dialog = document.createElement('dialog');
    this.dialog = dialog;
    dialog.className = 'microinterval-editor';
    // Labels are installed as text, so localized strings and segment names cannot
    // become HTML. Only the fixed editor skeleton uses innerHTML.
    dialog.innerHTML = `<form>
      <h2 data-label="microintervalEditorTitle"></h2>
      <label><span data-label="microintervalStructure"></span><select name="kind"><option value="simple" data-label="microintervalSimple"></option><option value="microintervals" data-label="microintervalTitle"></option></select></label>
      <label><span data-label="microintervalName"></span><input name="name" maxlength="100"></label>
      <div class="microinterval-editor__row"><label><span data-label="microintervalStart"></span><input name="start" required></label><label data-simple><span data-label="microintervalEnd"></span><input name="end"></label></div>
      <fieldset data-pattern><div class="microinterval-editor__row">
        <label><span data-label="microintervalCount"></span><input name="count" type="number" min="1" max="5000" value="10"></label>
        <label><span data-label="microintervalWorkSeconds"></span><input name="work" type="number" min="1" value="40"></label>
        <label><span data-label="microintervalRecoverySeconds"></span><input name="recovery" type="number" min="1" value="20"></label>
      </div><label class="microinterval-editor__checkbox"><input name="trailing" type="checkbox" checked><span data-label="microintervalTrailing"></span></label>
      <button type="button" data-detect data-label="microintervalDetectSelection"></button><select data-candidates hidden aria-label="Detected blocks"></select>
      <details><summary data-label="microintervalEditPhases"></summary><div data-phases></div></details></fieldset>
      <p data-summary aria-live="polite"></p><p data-error role="alert"></p>
      <div class="microinterval-editor__actions"><button type="button" data-cancel data-label="microintervalCancel"></button><button type="submit" data-save data-label="microintervalSave"></button></div>
    </form>`;
    for (const element of dialog.querySelectorAll('[data-label]')) element.textContent = this.t(element.dataset.label);
    const form = dialog.querySelector('form');
    this.form = form;
    form.elements.namedItem('kind').value = existing?.structure_kind ?? kind;
    form.elements.namedItem('name').value = existing?.segmentname ?? '';
    form.elements.namedItem('start').value = formatTime(existing?.start_offset ?? range.startIndex);
    form.elements.namedItem('end').value = formatTime(existing?.end_offset ?? range.endIndex);
    if (existing?.structure_kind === 'microintervals') this.loadBlock(existing);
    form.addEventListener('input', (event) => {
      if (['count', 'work', 'recovery', 'trailing', 'kind'].includes(event.target.name)) this.customDurations = null;
      if (event.target.dataset.phaseIndex !== undefined) {
        this.customDurations = [...(this.customDurations || this.draft?.phases.map((phase) => phase.duration) || [])];
        this.customDurations[Number(event.target.dataset.phaseIndex)] = Number(event.target.value);
        this.updatePreview(false);
      } else this.updatePreview();
    });
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.querySelector('[data-detect]').onclick = async (event) => {
      event.target.disabled = true;
      try {
        const { blocks } = await this.worker.scan(workout.workoutObject, { start: range.startIndex, end: range.endIndex + 1 });
        if (!dialog.open) return;
        if (!blocks.length) throw new Error(this.t('microintervalNone'));
        const select = dialog.querySelector('[data-candidates]');
        select.replaceChildren(...blocks.map((block, index) => {
          const option = document.createElement('option'); option.value = index;
          option.textContent = `${formatTime(block.start_offset)} · ${microIntervalPatternLabel(block)}`; return option;
        }));
        select.hidden = blocks.length < 2;
        select.onchange = () => { this.loadBlock(blocks[Number(select.value)]); this.updatePreview(); };
        form.elements.namedItem('kind').value = 'microintervals';
        this.loadBlock(blocks[0]); this.updatePreview();
      } catch (error) { dialog.querySelector('[data-error]').textContent = error.message; }
      finally { event.target.disabled = false; }
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      this.updatePreview(false);
      if (!this.draft) return;
      const save = dialog.querySelector('[data-save]'); save.disabled = true;
      try {
        const changes = [{ ...this.draft, segmenttype: 'manual', rowstate: existing ? 'UPD' : 'CRE', ...(existing ? { id: existing.id } : {}) }];
        await saveMicroIntervalChanges(workout, changes);
        this.onSaved(workout); dialog.close();
      } catch (error) { dialog.querySelector('[data-error]').textContent = error.message; save.disabled = false; }
    };
    dialog.addEventListener('close', () => {
      this.chart.previewMicroIntervalBlock = null;
      this.chart.previewMarkArea = null;
      this.chart.applyMarkAreas();
      dialog.remove();
    }, { once: true });
    document.body.append(dialog); dialog.showModal(); this.updatePreview();
  }
  loadBlock(block) {
    const form = this.form;
    const summary = summarizeMicroIntervalBlock(block);
    form.elements.namedItem('start').value = formatTime(block.start_offset);
    form.elements.namedItem('count').value = summary.repetitions;
    form.elements.namedItem('work').value = block.pattern_work_duration_seconds ?? block.phases[0].duration;
    form.elements.namedItem('recovery').value = block.pattern_recovery_duration_seconds ?? block.phases.find((phase) => phase.phase_kind === 'recovery')?.duration ?? 20;
    form.elements.namedItem('trailing').checked = block.phases.at(-1).phase_kind === 'recovery';
    this.customDurations = block.phases.map((phase) => phase.duration);
  }
  updatePreview(renderPhases = true) {
    const form = this.form, dialog = this.dialog;
    const isMicro = form.elements.namedItem('kind').value === 'microintervals';
    dialog.querySelector('[data-pattern]').hidden = !isMicro;
    dialog.querySelector('[data-pattern]').disabled = !isMicro;
    dialog.querySelector('[data-simple]').hidden = isMicro;
    this.draft = null;
    try {
      const start = parseSegmentTime(form.elements.namedItem('start').value);
      const name = form.elements.namedItem('name').value;
      if (isMicro) {
        this.draft = buildMicroIntervalBlock({ start, name,
          repetitions: Number(form.elements.namedItem('count').value),
          workSeconds: Number(form.elements.namedItem('work').value),
          recoverySeconds: Number(form.elements.namedItem('recovery').value),
          includeLastRecovery: form.elements.namedItem('trailing').checked,
          phaseDurations: this.customDurations }, workoutPhaseMetrics(this.workout.workoutObject));
      } else {
        const end = parseSegmentTime(form.elements.namedItem('end').value);
        if (end <= start || end >= this.workout.workoutObject.length) throw new Error(this.t('microintervalInvalidRange'));
        const segment = this.workout.workoutObject.createNewSegment({ startIndex: start, endIndex: end }, 'manual');
        if (!segment) throw new Error(this.t('microintervalInvalidRange'));
        this.draft = { ...segment, segmentname: name, structure_kind: 'simple', phases: [], pattern_work_duration_seconds: null, pattern_recovery_duration_seconds: null };
      }
      const block = this.draft;
      const summary = isMicro ? summarizeMicroIntervalBlock(block) : null;
      let text = `${this.t('microintervalBlockDuration')}: ${formatTime(block.duration)} · ${this.t('microintervalEnd')}: ${formatTime(block.end_offset + (isMicro ? 1 : 0))}`;
      if (summary) text += ` · ${this.t('microintervalWorkTime')}: ${formatTime(summary.workSeconds)}`;
      const difference = block.end_offset - this.range.endIndex;
      if (isMicro && difference) text += ` · ${this.t('microintervalSelectionDifference', { seconds: difference })}`;
      dialog.querySelector('[data-summary]').textContent = text;
      dialog.querySelector('[data-error]').textContent = '';
      this.chart.previewMicroIntervalBlock = isMicro ? block : null;
      this.chart.previewMarkArea = this.chart.buildSelectionPreviewArea(block.start_offset, block.end_offset);
      this.chart.applyMarkAreas();
      if (isMicro && renderPhases) {
        const container = dialog.querySelector('[data-phases]'); container.replaceChildren();
        for (const phase of block.phases) {
          const label = document.createElement('label'); label.className = 'microinterval-editor__phase';
          const text = document.createElement('span'); text.textContent = `${phase.repetition_index} · ${this.t(phase.phase_kind === 'work' ? 'microintervalWork' : 'microintervalRecovery')}`;
          const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.value = phase.duration;
          input.dataset.phaseIndex = phase.position; label.append(text, input); container.append(label);
        }
      }
    } catch (error) {
      this.draft = null;
      dialog.querySelector('[data-error]').textContent = error.message;
      this.chart.previewMicroIntervalBlock = null; this.chart.previewMarkArea = null; this.chart.applyMarkAreas();
    }
  }
}
