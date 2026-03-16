const uploadForm = document.getElementById("uploadForm");

uploadForm.addEventListener("submit", async function (e) {

    e.preventDefault();

    const fileInput = document.getElementById("file");
    const file = fileInput.files[0];

    if (!file) return;

    const responseDiv = document.getElementById("response");

    responseDiv.innerHTML =
        '<div class="alert alert-info">Upload läuft...</div>';

    const formData = new FormData();
    formData.append("file", file);

    try {

        const res = await fetch("/files/upload", {
            method: "POST",
            credentials: "include",
            body: formData
        });

        const data = await res.json();
        const jobId = data.jobId;

        const source = new EventSource(`/progress/${jobId}`);
        responseDiv.innerHTML = 'Transfering';
        source.onmessage = (event) => {

            const datax = JSON.parse(event.data);

            responseDiv.innerHTML = datax.file;

            console.log(datax);

            if (datax.status === "done") {
                source.close();
                responseDiv.innerHTML = "done";
            }

        };

        responseDiv.innerHTML =
            '<div class="alert alert-success">Upload erfolgreich</div>';

        console.log(data);

    } catch (err) {

        responseDiv.innerHTML =
            '<div class="alert alert-danger">Fehler beim Upload</div>';

        console.error(err);

    }

});