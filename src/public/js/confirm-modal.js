let sharedModalElements = null;

function ensureModalElements() {
  if (sharedModalElements) {
    return sharedModalElements;
  }

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div class="modal fade" tabindex="-1" aria-hidden="true" data-confirm-modal>
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content border-0 shadow">
          <div class="modal-header">
            <h5 class="modal-title">Confirmation</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <p class="mb-0" style="white-space: pre-line;" data-confirm-message></p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-confirm-cancel>Cancel</button>
            <button type="button" class="btn btn-danger" data-confirm-accept>Delete</button>
          </div>
        </div>
      </div>
    </div>
  `.trim();

  const modalElement = wrapper.firstElementChild;
  document.body.appendChild(modalElement);

  sharedModalElements = {
    modalElement,
    messageElement: modalElement.querySelector("[data-confirm-message]"),
    titleElement: modalElement.querySelector(".modal-title"),
    acceptButton: modalElement.querySelector("[data-confirm-accept]"),
    cancelButton: modalElement.querySelector("[data-confirm-cancel]")
  };

  return sharedModalElements;
}

export default function confirmModal({
  title = "Confirmation",
  message = "Are you sure?",
  acceptLabel = "Delete",
  cancelLabel = "Cancel",
  acceptClass = "btn-danger"
} = {}) {
  if (!globalThis.bootstrap?.Modal) {
    return Promise.resolve(globalThis.confirm(message));
  }

  const { modalElement, messageElement, titleElement, acceptButton, cancelButton } = ensureModalElements();
  const modal = globalThis.bootstrap.Modal.getOrCreateInstance(modalElement, {
    backdrop: "static",
    keyboard: true
  });

  titleElement.textContent = title;
  messageElement.textContent = message;
  acceptButton.textContent = acceptLabel;
  cancelButton.textContent = cancelLabel;

  acceptButton.className = "btn";
  acceptButton.classList.add(...String(acceptClass).split(" ").filter(Boolean));

  return new Promise((resolve) => {
    let settled = false;
    let pendingResult = false;
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const blurModalFocus = () => {
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        modalElement.contains(activeElement)
      ) {
        activeElement.blur();
      }
    };

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (previousActiveElement && document.contains(previousActiveElement)) {
        previousActiveElement.focus();
      }
      resolve(value);
    };

    const requestClose = (value) => {
      if (settled) {
        return;
      }

      pendingResult = value;
      blurModalFocus();
      modal.hide();
    };

    const onAccept = () => requestClose(true);
    const onCancel = () => requestClose(false);
    const onHidden = () => finish(pendingResult);

    const cleanup = () => {
      acceptButton.removeEventListener("click", onAccept);
      cancelButton.removeEventListener("click", onCancel);
      modalElement.removeEventListener("hidden.bs.modal", onHidden);
    };

    acceptButton.addEventListener("click", onAccept);
    cancelButton.addEventListener("click", onCancel);
    modalElement.addEventListener("hidden.bs.modal", onHidden);

    modal.show();

    Promise.resolve().then(() => {
      cancelButton.focus();
    });
  });
}
