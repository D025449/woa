import { createTranslator } from "./i18n.js";

export function createUploadUI() {
    const t = createTranslator("upload");
    const elements = {
        form: document.getElementById('uploadForm'),
        fileInput: document.getElementById('file'),
        filePickerButton: document.getElementById('filePickerButton'),
        filePickerLabel: document.getElementById('filePickerLabel'),
        shareModeInputs: Array.from(document.querySelectorAll('input[name="shareMode"]')),
        groupSharePanel: document.getElementById('groupSharePanel'),
        groupShareHint: document.getElementById('groupShareHint'),
        groupShareList: document.getElementById('groupShareList'),
        submitButton: document.getElementById('submitButton'),
        response: document.getElementById('response'),

        statusArea: document.getElementById('statusArea'),
        phaseText: document.getElementById('phaseText'),

        uploadProgressBar: document.getElementById('uploadProgressBar'),
        uploadPercentText: document.getElementById('uploadPercentText'),
        uploadDetailText: document.getElementById('uploadDetailText'),

        processingProgressBar: document.getElementById('processingProgressBar'),
        processingPercentText: document.getElementById('processingPercentText'),
        processingDetailText: document.getElementById('processingDetailText')
    };

    function showStatusArea() {
        elements.statusArea.classList.remove('d-none');
    }

    function setLoading(isLoading) {
        elements.submitButton.disabled = isLoading;
    }

    function setPhase(text) {
        elements.phaseText.textContent = text;
    }

    function setUploadProgress(percent, detailText = '') {
        elements.uploadProgressBar.style.width = `${percent}%`;
        elements.uploadProgressBar.setAttribute('aria-valuenow', String(percent));
        elements.uploadPercentText.textContent = `${percent}%`;
        elements.uploadDetailText.textContent = detailText;
    }

    function setProcessingProgress(percent, detailText = '') {
        elements.processingProgressBar.style.width = `${percent}%`;
        elements.processingProgressBar.setAttribute('aria-valuenow', String(percent));
        elements.processingPercentText.textContent = `${Math.round(percent)}%`;
        elements.processingDetailText.textContent = detailText;
    }

    function setError(message) {
        elements.response.innerHTML = `<div class="alert alert-danger mb-0">${message}</div>`;
    }

    function setSuccess(message) {
        elements.response.innerHTML = `<div class="alert alert-success mb-0">${message}</div>`;
    }

    function setInfo(message) {
        elements.response.innerHTML = `<div class="alert alert-info mb-0">${message}</div>`;
    }

    function clearMessage() {
        elements.response.innerHTML = '';
    }

    function getSelectedFiles() {
        return Array.from(elements.fileInput.files || []);
    }

    function getSelectedShareMode() {
        const selectedInput = elements.shareModeInputs.find((input) => input.checked);
        return selectedInput?.value || 'private';
    }

    function getSelectedGroupIds() {
        return Array.from(
            elements.groupShareList?.querySelectorAll('input[type="checkbox"]:checked') || []
        ).map((input) => Number(input.value)).filter((value) => Number.isInteger(value) && value > 0);
    }

    function setShareGroups(groups = []) {
        if (!elements.groupShareList) {
            return;
        }

        if (!groups.length) {
            elements.groupShareList.innerHTML = '';
            if (elements.groupShareHint) {
                elements.groupShareHint.textContent = t("hintNoGroups");
            }
            return;
        }

        if (elements.groupShareHint) {
            elements.groupShareHint.textContent = t("hintAppliesToAll");
        }

        elements.groupShareList.innerHTML = groups.map((group) => `
            <label class="upload-share-option">
                <input type="checkbox" value="${group.id}">
                <span>
                    <strong>${group.name}</strong>
                    <small>${group.role || t("memberFallback")} · ${group.member_count || 0} ${t("membersSuffix")}</small>
                </span>
            </label>
        `).join('');
    }

    function syncSharePanel() {
        if (!elements.groupSharePanel) {
            return;
        }

        const mode = getSelectedShareMode();
        elements.groupSharePanel.classList.toggle('d-none', mode !== 'groups');
    }

    elements.shareModeInputs.forEach((input) => {
        input.addEventListener('change', syncSharePanel);
    });

    function updateFilePickerLabel() {
        if (!elements.filePickerLabel || !elements.fileInput) {
            return;
        }

        const fileCount = elements.fileInput.files?.length || 0;
        if (fileCount === 0) {
            elements.filePickerLabel.textContent = t("noFilesSelected");
            return;
        }

        if (fileCount === 1) {
            elements.filePickerLabel.textContent = elements.fileInput.files[0].name;
            return;
        }

        elements.filePickerLabel.textContent = t("filesSelected", { count: fileCount });
    }

    if (elements.filePickerButton && elements.fileInput) {
        elements.filePickerButton.addEventListener('click', () => {
            elements.fileInput.click();
        });
    }

    if (elements.fileInput) {
        elements.fileInput.addEventListener('change', updateFilePickerLabel);
    }

    syncSharePanel();
    updateFilePickerLabel();

    return {
        elements,
        showStatusArea,
        setLoading,
        setPhase,
        setUploadProgress,
        setProcessingProgress,
        setError,
        setSuccess,
        setInfo,
        clearMessage,
        getSelectedFiles,
        getSelectedShareMode,
        getSelectedGroupIds,
        setShareGroups,
        syncSharePanel
    };
}
