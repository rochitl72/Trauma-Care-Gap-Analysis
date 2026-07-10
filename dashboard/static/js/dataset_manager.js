const FACILITY_LABELS = {
  hospital: "hospital reach",
  ambulance: "ambulance reach",
  bloodbank: "blood bank reach",
  scorecard: "district scorecard",
};

let pollTimer = null;

function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

async function refreshDatasetStatus() {
  const el = document.getElementById("dataset-status");
  const resetBtn = document.getElementById("reset-dataset-btn");
  try {
    const data = await fetch("/api/dataset").then((r) => r.json());
    if (data.source === "custom") {
      el.textContent = `Using uploaded file "${data.filename}" (${data.row_count} rows), uploaded ${timeAgo(data.uploaded_at)}.`;
      el.classList.remove("error");
      resetBtn.disabled = false;
    } else {
      el.textContent = "Using the default demo dataset (haryana_synthetic_accidents.csv).";
      el.classList.remove("error");
      resetBtn.disabled = true;
    }
  } catch (err) {
    console.error(err);
    el.textContent = "Couldn't load dataset info.";
    el.classList.add("error");
  }
}

function setPipelineBanner(status) {
  const banner = document.getElementById("pipeline-status");
  if (!banner) return;

  if (status.state === "running") {
    const label = FACILITY_LABELS[status.facility] || "reach analysis";
    const { done, total } = status.progress || {};
    const progressText = total ? ` (${done}/${total})` : "";
    banner.textContent = `Recomputing ${label}${progressText}… other views may show stale data until this finishes.`;
    banner.classList.remove("error");
    banner.style.display = "block";
  } else if (status.state === "error") {
    banner.textContent = `Recompute failed: ${status.error}`;
    banner.classList.add("error");
    banner.style.display = "block";
  } else if (status.state === "done") {
    banner.textContent = "Recompute finished — reach views are up to date.";
    banner.classList.remove("error");
    banner.style.display = "block";
    setTimeout(() => {
      banner.style.display = "none";
    }, 6000);
  } else {
    banner.style.display = "none";
  }
}

async function pollPipelineOnce() {
  try {
    const status = await fetch("/api/pipeline/status").then((r) => r.json());
    setPipelineBanner(status);
    if (status.state === "running") {
      pollTimer = setTimeout(pollPipelineOnce, 2000);
    } else {
      pollTimer = null;
    }
    return status;
  } catch (err) {
    console.error(err);
    return null;
  }
}

function startPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollPipelineOnce();
}

async function uploadFile(file) {
  const el = document.getElementById("dataset-status");
  el.textContent = `Uploading ${file.name}…`;
  el.classList.remove("error");

  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch("/api/accidents/upload", { method: "POST", body: formData });
    const data = await response.json();
    if (!response.ok) {
      el.textContent = data.error || "Upload failed.";
      el.classList.add("error");
      return;
    }
    await refreshDatasetStatus();
    startPolling();
  } catch (err) {
    console.error(err);
    el.textContent = "Upload failed — check the console.";
    el.classList.add("error");
  }
}

async function resetDataset() {
  const el = document.getElementById("dataset-status");
  el.textContent = "Removing uploaded file…";
  el.classList.remove("error");
  try {
    await fetch("/api/accidents/reset", { method: "POST" });
    await refreshDatasetStatus();
    startPolling();
  } catch (err) {
    console.error(err);
    el.textContent = "Couldn't remove the uploaded file.";
    el.classList.add("error");
  }
}

document.getElementById("accident-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) uploadFile(file);
  e.target.value = "";
});

document.getElementById("reset-dataset-btn").addEventListener("click", () => {
  if (confirm("Remove the uploaded dataset and revert to the default demo data?")) {
    resetDataset();
  }
});

refreshDatasetStatus();
pollPipelineOnce();
