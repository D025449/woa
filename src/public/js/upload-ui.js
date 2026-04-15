export function createUploadUI() {
    const elements = {
        form: document.getElementById('uploadForm'),
        fileInput: document.getElementById('file'),
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
        getSelectedFiles
    };
}
