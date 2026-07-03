(function ()
{
    "use strict";

    const dropZone = document.getElementById("dropZone");
    const fileInput = document.getElementById("fileInput");
    const browseBtn = document.getElementById("browseBtn");
    const fileList = document.getElementById("fileList");
    const fileCount = document.getElementById("fileCount");
    const uploadStatus = document.getElementById("uploadStatus");
    const pasteEntries = document.getElementById("pasteEntries");
    const addPasteBtn = document.getElementById("addPasteBtn");
    const pasteCharCount = document.getElementById("pasteCharCount");
    const analyzeBtn = document.getElementById("analyzeBtn");
    const btnSpinner = document.getElementById("btnSpinner");
    const btnLabel = analyzeBtn.querySelector(".btn-label");
    const resultZone = document.getElementById("resultZone");
    const resultStatus = document.getElementById("resultStatus");
    const skillPreview = document.getElementById("skillPreview");
    const downloadBtn = document.getElementById("downloadBtn");
    const copyBtn = document.getElementById("copyBtn");
    const newAnalysisBtn = document.getElementById("newAnalysisBtn");
    const toast = document.getElementById("toast");
    const footerConfig = document.getElementById("footerConfig");
    const modelSelect = document.getElementById("modelSelect");
    const modelStatus = document.getElementById("modelStatus");
    const urlInput = document.getElementById("urlInput");
    const addUrlBtn = document.getElementById("addUrlBtn");
    const urlList = document.getElementById("urlList");
    const urlCount = document.getElementById("urlCount");
    const translateZone = document.getElementById("translateZone");
    const translateInput = document.getElementById("translateInput");
    const translateBtn = document.getElementById("translateBtn");
    const translateStatus = document.getElementById("translateStatus");
    const translateOutput = document.getElementById("translateOutput");
    const translatePreview = document.getElementById("translatePreview");
    const profileSelect = document.getElementById("profileSelect");
    const deleteProfileBtn = document.getElementById("deleteProfileBtn");
    const profileCount = document.getElementById("profileCount");
    const profileHint = document.getElementById("profileHint");
    const profileNameInput = document.getElementById("profileNameInput");
    const saveProfileBtn = document.getElementById("saveProfileBtn");
    const convertZone = document.getElementById("convertZone");
    const convertInput = document.getElementById("convertInput");
    const convertLang = document.getElementById("convertLang");
    const convertBtn = document.getElementById("convertBtn");
    const convertStatus = document.getElementById("convertStatus");
    const convertOutput = document.getElementById("convertOutput");
    const convertPreview = document.getElementById("convertPreview");
    const convertCopyBtn = document.getElementById("convertCopyBtn");

    let uploadedFiles = [];
    let urlEntries = [];
    let analysisResult = null;
    let analysisId = null;
    let selectedModel = null;
    let activeProfileId = null;
    let convertResult = null;

    /* ===== Model Selector & Footer ===== */
    fetch("/api/config")
        .then((r) => r.json())
        .then((cfg) =>
        {
            footerConfig.textContent = "Provider: " + (cfg.provider === "claude_cli" ? "Claude CLI" : "API") + " | Model: " + (cfg.model || "deepseek-chat");

            if (cfg.groups && cfg.groups.length > 0)
            {
                modelSelect.innerHTML = "";
                for (const group of cfg.groups)
                {
                    const optgroup = document.createElement("optgroup");
                    optgroup.label = group.label;
                    for (const m of group.models)
                    {
                        const opt = document.createElement("option");
                        opt.value = m;
                        opt.textContent = m;
                        if (m === cfg.model)
                        {
                            opt.selected = true;
                        }
                        optgroup.appendChild(opt);
                    }
                    modelSelect.appendChild(optgroup);
                }
                selectedModel = modelSelect.value || cfg.model;
                if (modelStatus)
                {
                    let total = 0;
                    for (const g of cfg.groups)
                    {
                        total += g.models.length;
                    }
                    modelStatus.textContent = total + " models";
                    modelStatus.classList.remove("hidden");
                }
            }
            else
            {
                modelSelect.innerHTML = `<option value="${cfg.model}">${cfg.model}</option>`;
                selectedModel = cfg.model;
                if (modelStatus)
                {
                    modelStatus.textContent = "default";
                    modelStatus.classList.remove("hidden");
                }
            }

            modelSelect.addEventListener("change", () =>
            {
                selectedModel = modelSelect.value;
                footerConfig.textContent = "Model: " + (selectedModel || cfg.model);
                if (modelStatus)
                {
                    modelStatus.textContent = selectedModel;
                }
            });
        })
        .catch(() =>
        {
            footerConfig.textContent = "Model: deepseek-chat";
            modelSelect.innerHTML = '<option value="deepseek-chat">deepseek-chat</option>';
            selectedModel = "deepseek-chat";
        });

    /* ===== File Upload ===== */
    browseBtn.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", () =>
    {
        if (fileInput.files.length > 0)
        {
            handleNewFiles(fileInput.files);
            fileInput.value = "";
        }
    });

    dropZone.addEventListener("dragover", (e) =>
    {
        e.preventDefault();
        dropZone.classList.add("drag-over");
    });

    dropZone.addEventListener("dragleave", () =>
    {
        dropZone.classList.remove("drag-over");
    });

    dropZone.addEventListener("drop", (e) =>
    {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        if (e.dataTransfer.files.length > 0)
        {
            handleNewFiles(e.dataTransfer.files);
        }
    });

    dropZone.addEventListener("click", (e) =>
    {
        if (!browseBtn.contains(e.target))
        {
            fileInput.click();
        }
    });

    async function handleNewFiles(fileListRaw)
    {
        const formData = new FormData();
        let fileCount_ = 0;

        for (const file of fileListRaw)
        {
            const ext = file.name.split(".").pop().toLowerCase();
            const allowed = ["txt","md","csv","log","cpp","c","h","hpp","cs","java","py","js","ts","jsx","tsx","rs","go","rb","php","swift","kt","html","css","scss","json","xml","yaml","yml","docx","pdf"];

            if (!allowed.includes(ext))
            {
                showToast("Skipped unsupported file: " + file.name, "error");
                continue;
            }

            if (uploadedFiles.length + fileCount_ >= 10)
            {
                showToast("Maximum 10 files allowed.", "error");
                break;
            }

            formData.append("files", file);
            fileCount_++;
        }

        if (fileCount_ === 0)
        {
            return;
        }

        uploadStatus.textContent = "Uploading " + fileCount_ + " file(s)...";
        uploadStatus.className = "upload-status";

        try
        {
            const res = await fetch("/api/upload", { method: "POST", body: formData });
            const data = await res.json();

            if (!res.ok || !data.ok)
            {
                throw new Error(data.error || "Upload failed.");
            }

            for (const f of data.files)
            {
                uploadedFiles.push(f);
            }

            uploadStatus.textContent = fileCount_ + " file(s) uploaded successfully.";
            uploadStatus.className = "upload-status upload-ok";
        }
        catch (err)
        {
            uploadStatus.textContent = "Error: " + err.message;
            uploadStatus.className = "upload-status upload-error";
            showToast(err.message, "error");
        }

        renderFileList();
        updateAnalyzeButton();
    }

    function renderFileList()
    {
        fileList.innerHTML = "";
        fileCount.textContent = uploadedFiles.length + " file" + (uploadedFiles.length !== 1 ? "s" : "");

        for (let i = 0; i < uploadedFiles.length; i++)
        {
            const f = uploadedFiles[i];
            const chip = document.createElement("div");
            chip.className = "file-chip";

            const nameSpan = document.createElement("span");
            nameSpan.className = "file-chip-name";
            nameSpan.textContent = f.name;
            nameSpan.title = f.name;

            const sizeSpan = document.createElement("span");
            sizeSpan.className = "file-chip-size";
            sizeSpan.textContent = formatSize(f.size);

            const removeSpan = document.createElement("span");
            removeSpan.className = "file-chip-remove";
            removeSpan.textContent = "\u00d7";
            removeSpan.title = "Remove";
            removeSpan.addEventListener("click", () =>
            {
                uploadedFiles.splice(i, 1);
                renderFileList();
                updateAnalyzeButton();
            });

            chip.appendChild(nameSpan);
            chip.appendChild(sizeSpan);
            chip.appendChild(removeSpan);
            fileList.appendChild(chip);
        }
    }

    function formatSize(bytes)
    {
        if (bytes < 1024)
        {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024)
        {
            return (bytes / 1024).toFixed(1) + " KB";
        }
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    /* ===== Paste Area ===== */

    let pasteEntryCounter = 1;

    addPasteBtn.addEventListener("click", () =>
    {
        const entry = document.createElement("div");
        entry.className = "paste-entry";
        entry.dataset.idx = pasteEntryCounter;

        const title = document.createElement("input");
        title.type = "text";
        title.className = "paste-title";
        title.placeholder = "Title (e.g. email, blog post, notes)";

        const textarea = document.createElement("textarea");
        textarea.className = "paste-area";
        textarea.placeholder = "Paste any text here...";
        textarea.addEventListener("input", updatePasteStats);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "paste-remove-btn";
        removeBtn.textContent = "\u00d7";
        removeBtn.title = "Remove";
        removeBtn.addEventListener("click", () =>
        {
            entry.remove();
            updatePasteStats();
            updateRemoveButtons();
        });

        entry.appendChild(title);
        entry.appendChild(textarea);
        entry.appendChild(removeBtn);
        pasteEntries.appendChild(entry);

        pasteEntryCounter++;
        updateRemoveButtons();
    });

    function updateRemoveButtons()
    {
        const entries = pasteEntries.querySelectorAll(".paste-entry");
        for (const entry of entries)
        {
            const btn = entry.querySelector(".paste-remove-btn");
            if (entries.length > 1)
            {
                btn.classList.remove("hidden");
            }
            else
            {
                btn.classList.add("hidden");
            }
        }
    }

    function updatePasteStats()
    {
        let total = 0;
        const areas = pasteEntries.querySelectorAll(".paste-area");
        for (const area of areas)
        {
            total += area.value.length;
        }
        pasteCharCount.textContent = total + " char" + (total !== 1 ? "s" : "");
        updateAnalyzeButton();
    }

    pasteEntries.querySelector(".paste-area").addEventListener("input", updatePasteStats);
    updateRemoveButtons();

    /* ===== URL Input ===== */

    async function fetchUrl()
    {
        const url = urlInput.value.trim();
        if (!url)
        {
            return;
        }

        urlInput.value = "";
        addUrlBtn.disabled = true;
        urlInput.disabled = true;

        const chip = document.createElement("div");
        chip.className = "url-chip loading";
        const nameSpan = document.createElement("span");
        nameSpan.className = "url-chip-name";
        nameSpan.textContent = url;
        nameSpan.title = url;
        chip.appendChild(nameSpan);
        urlList.appendChild(chip);
        updateUrlCount();

        try
        {
            const res = await fetch("/api/fetch-url", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url })
            });

            const data = await res.json();

            if (!res.ok || !data.ok)
            {
                throw new Error(data.error || "Fetch failed.");
            }

            chip.classList.remove("loading");
            nameSpan.textContent = data.title;
            nameSpan.title = url;

            const removeSpan = document.createElement("span");
            removeSpan.className = "url-chip-remove";
            removeSpan.textContent = "\u00d7";
            removeSpan.title = "Remove";
            const entryId = data.id;
            removeSpan.addEventListener("click", () =>
            {
                chip.remove();
                urlEntries = urlEntries.filter((e) => e.id !== entryId);
                updateUrlCount();
                updateAnalyzeButton();
            });
            chip.appendChild(removeSpan);

            urlEntries.push({ id: data.id, title: data.title, url });
            updateAnalyzeButton();
        }
        catch (err)
        {
            chip.classList.remove("loading");
            chip.classList.add("error");
            const removeSpan = document.createElement("span");
            removeSpan.className = "url-chip-remove";
            removeSpan.textContent = "\u00d7";
            removeSpan.title = "Remove";
            removeSpan.addEventListener("click", () =>
            {
                chip.remove();
                updateUrlCount();
                updateAnalyzeButton();
            });
            chip.appendChild(removeSpan);
            showToast(err.message, "error");
        }
        finally
        {
            addUrlBtn.disabled = false;
            urlInput.disabled = false;
            urlInput.focus();
        }

        updateUrlCount();
    }

    addUrlBtn.addEventListener("click", fetchUrl);
    urlInput.addEventListener("keydown", (e) =>
    {
        if (e.key === "Enter")
        {
            e.preventDefault();
            fetchUrl();
        }
    });

    function updateUrlCount()
    {
        const chips = urlList.querySelectorAll(".url-chip:not(.error)");
        urlCount.textContent = chips.length + " URL" + (chips.length !== 1 ? "s" : "");
    }

    /* ===== Analyze Button ===== */
    function updateAnalyzeButton()
    {
        const hasFiles = uploadedFiles.length > 0;
        const hasUrls = urlEntries.length > 0;
        let hasPaste = false;
        const areas = pasteEntries.querySelectorAll(".paste-area");
        for (const area of areas)
        {
            if (area.value.trim().length > 0)
            {
                hasPaste = true;
                break;
            }
        }

        analyzeBtn.disabled = !(hasFiles || hasPaste || hasUrls);
    }

    analyzeBtn.addEventListener("click", runAnalysis);

    async function runAnalysis()
    {
        let hasPaste = false;
        const areas = pasteEntries.querySelectorAll(".paste-area");
        for (const area of areas)
        {
            if (area.value.trim().length > 0)
            {
                hasPaste = true;
                break;
            }
        }
        const hasFiles = uploadedFiles.length > 0;
        const hasUrls = urlEntries.length > 0;

        if (!hasFiles && !hasPaste && !hasUrls)
        {
            return;
        }

        analyzeBtn.disabled = true;
        btnLabel.textContent = "Analyzing...";
        btnSpinner.classList.remove("hidden");
        resultZone.classList.add("hidden");
        uploadStatus.textContent = "";
        uploadStatus.className = "upload-status";

        const pasteTexts = [];
        const entries = pasteEntries.querySelectorAll(".paste-entry");
        for (const entry of entries)
        {
            const title = entry.querySelector(".paste-title");
            const textarea = entry.querySelector(".paste-area");
            const text = textarea.value.trim();
            if (text.length > 0)
            {
                pasteTexts.push({
                    source: title.value.trim() || "pasted-text-" + pasteTexts.length,
                    content: text
                });
            }
        }

        const body = {
            fileIds: uploadedFiles.map((f) => f.id),
            urlIds: urlEntries.map((u) => u.id),
            pasteTexts: pasteTexts,
            model: selectedModel
        };

        try
        {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 310000);

            const res = await fetch("/api/analyze-with-paste", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            const data = await res.json();

            if (!res.ok || !data.ok)
            {
                throw new Error(data.error || "Analysis failed.");
            }

            analysisResult = data.analysis.skillMd;
            analysisId = data.analysisId;
            const currentAnalysisId = data.analysisId;

            if (data.warning)
            {
                showToast(data.warning, "error");
            }

            const strategyLabel = data.strategy === "batched"
                ? ` (${data.batches} batches merged)`
                : "";
            resultStatus.textContent = "Ready" + strategyLabel;
            resultStatus.className = "badge badge-success";
            skillPreview.textContent = analysisResult;
            resultZone.classList.remove("hidden");
            translateZone.classList.remove("hidden");
            translateInput.value = "";
            translateOutput.classList.add("hidden");
            translateStatus.textContent = "";
            convertZone.classList.remove("hidden");
            convertOutput.classList.add("hidden");
            convertStatus.textContent = "";
            activeProfileId = null;
            profileSelect.value = "";
            deleteProfileBtn.disabled = true;
            profileNameInput.value = "";
            profileHint.textContent = "New style ready. Name and save it below to reuse it later.";

            downloadBtn.onclick = async () =>
            {
                try
                {
                    const dlRes = await fetch("/api/download/" + currentAnalysisId);
                    if (!dlRes.ok)
                    {
                        showToast("Download failed: file may have expired.", "error");
                        return;
                    }
                    const blob = await dlRes.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "Skill.md";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }
                catch (_)
                {
                    showToast("Download failed. Please try again.", "error");
                }
            };

            showToast("Analysis complete! Your Skill.md is ready.", "success");
            resultZone.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        catch (err)
        {
            if (err.name === "AbortError")
            {
                showToast("Analysis timed out (5 min limit). Try fewer files or a faster model.", "error");
            }
            else
            {
                showToast(err.message, "error");
            }
        }
        finally
        {
            btnLabel.textContent = "Analyze My Style";
            btnSpinner.classList.add("hidden");
            analyzeBtn.disabled = false;
        }
    }

    /* ===== Copy Button ===== */
    copyBtn.addEventListener("click", () =>
    {
        if (!analysisResult)
        {
            return;
        }

        navigator.clipboard.writeText(analysisResult).then(() =>
        {
            showToast("Copied to clipboard!", "success");
        }).catch(() =>
        {
            const ta = document.createElement("textarea");
            ta.value = analysisResult;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            showToast("Copied to clipboard!", "success");
        });
    });

    /* ===== Style Translate ===== */

    translateBtn.addEventListener("click", async () =>
    {
        const text = translateInput.value.trim();
        if (!text)
        {
            return;
        }

        if (!analysisResult)
        {
            showToast("Run an analysis first to generate your style.", "error");
            return;
        }

        const direction = document.querySelector("input[name='translateDir']:checked").value;

        translateBtn.disabled = true;
        translateStatus.textContent = "Translating...";
        translateOutput.classList.add("hidden");

        try
        {
            const res = await fetch("/api/translate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text,
                    direction,
                    skillMd: analysisResult,
                    model: selectedModel
                })
            });

            const data = await res.json();

            if (!res.ok || !data.ok)
            {
                throw new Error(data.error || "Translation failed.");
            }

            translatePreview.textContent = data.translated;
            translateOutput.classList.remove("hidden");
            translateStatus.textContent = "Done.";
        }
        catch (err)
        {
            showToast(err.message, "error");
            translateStatus.textContent = "Failed.";
        }
        finally
        {
            translateBtn.disabled = false;
        }
    });

    /* ===== New Analysis Button ===== */
    newAnalysisBtn.addEventListener("click", () =>
    {
        uploadedFiles = [];
        urlEntries = [];
        analysisResult = null;
        analysisId = null;

        urlInput.value = "";
        urlList.innerHTML = "";
        updateUrlCount();

        pasteEntries.innerHTML = "";
        const entry = document.createElement("div");
        entry.className = "paste-entry";
        entry.dataset.idx = "0";
        const title = document.createElement("input");
        title.type = "text";
        title.className = "paste-title";
        title.placeholder = "Title (e.g. email, blog post, notes)";
        const textarea = document.createElement("textarea");
        textarea.className = "paste-area";
        textarea.placeholder = "Paste any text here...";
        textarea.addEventListener("input", updatePasteStats);
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "paste-remove-btn hidden";
        removeBtn.textContent = "\u00d7";
        removeBtn.title = "Remove";
        removeBtn.addEventListener("click", () =>
        {
            entry.remove();
            updatePasteStats();
            updateRemoveButtons();
        });
        entry.appendChild(title);
        entry.appendChild(textarea);
        entry.appendChild(removeBtn);
        pasteEntries.appendChild(entry);

        pasteEntryCounter = 1;
        pasteCharCount.textContent = "0 chars";
        renderFileList();
        updateAnalyzeButton();
        updateRemoveButtons();
        resultZone.classList.add("hidden");
        translateZone.classList.add("hidden");
        convertZone.classList.add("hidden");
        convertOutput.classList.add("hidden");
        convertInput.value = "";
        convertStatus.textContent = "";
        convertResult = null;
        activeProfileId = null;
        profileSelect.value = "";
        deleteProfileBtn.disabled = true;
        profileHint.textContent = "Pick a saved style to rewrite new text in your voice — or analyze below to create one.";
        uploadStatus.textContent = "";
        uploadStatus.className = "upload-status";
        window.scrollTo({ top: 0, behavior: "smooth" });

        fetch("/api/clear", { method: "POST" }).catch(() => {});
    });

    /* ===== Toast ===== */
    let toastTimer = null;

    function showToast(message, type)
    {
        if (toastTimer)
        {
            clearTimeout(toastTimer);
        }

        toast.textContent = message;
        toast.className = "toast toast-" + type;
        toast.classList.remove("hidden");

        toastTimer = setTimeout(() =>
        {
            toast.classList.add("hidden");
            toastTimer = null;
        }, 3500);
    }

    /* ===== Activity Log (SSE) ===== */
    const logEntries = document.getElementById("logEntries");
    const logClearBtn = document.getElementById("logClearBtn");

    logClearBtn.addEventListener("click", () =>
    {
        logEntries.innerHTML = '<div class="log-entry log-placeholder">Cleared.</div>';
        setTimeout(() =>
        {
            const placeholder = logEntries.querySelector(".log-placeholder");
            if (placeholder)
            {
                placeholder.textContent = "Waiting for activity...";
            }
        }, 2000);
    });

    function formatLogTime(ts)
    {
        const d = new Date(ts);
        const h = String(d.getHours()).padStart(2, "0");
        const m = String(d.getMinutes()).padStart(2, "0");
        const s = String(d.getSeconds()).padStart(2, "0");
        return h + ":" + m + ":" + s;
    }

    function appendLogEntry(entry)
    {
        const placeholder = logEntries.querySelector(".log-placeholder");
        if (placeholder)
        {
            placeholder.remove();
        }

        const div = document.createElement("div");
        div.className = "log-entry";

        const timeSpan = document.createElement("span");
        timeSpan.className = "log-time";
        timeSpan.textContent = formatLogTime(entry.ts);

        const typeSpan = document.createElement("span");
        typeSpan.className = "log-type log-type-" + (entry.type || "info");
        typeSpan.textContent = entry.type || "info";

        const msgSpan = document.createElement("span");
        msgSpan.className = "log-msg";
        msgSpan.textContent = entry.message;

        div.appendChild(timeSpan);
        div.appendChild(typeSpan);
        div.appendChild(msgSpan);
        logEntries.appendChild(div);

        logEntries.scrollTop = logEntries.scrollHeight;
    }

    try
    {
        const evtSource = new EventSource("/api/logs/stream");
        evtSource.onmessage = (e) =>
        {
            try
            {
                const entry = JSON.parse(e.data);
                appendLogEntry(entry);
            }
            catch (_)
            {
            }
        };
        evtSource.onerror = () =>
        {
        };
    }
    catch (_)
    {
    }

    /* ===== Style Profiles + Convert ===== */

    function setActiveStyle(skillMd, profileId)
    {
        analysisResult = skillMd || null;
        activeProfileId = profileId || null;
        const hasStyle = Boolean(analysisResult);
        convertZone.classList.toggle("hidden", !hasStyle);
        translateZone.classList.toggle("hidden", !hasStyle);
    }

    function renderProfileOptions(profiles, selectId)
    {
        profileSelect.innerHTML = "";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = profiles.length > 0 ? "Select a saved style..." : "No profile saved yet";
        profileSelect.appendChild(none);
        for (const p of profiles)
        {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = p.name;
            if (p.id === selectId)
            {
                opt.selected = true;
            }
            profileSelect.appendChild(opt);
        }
        profileCount.textContent = profiles.length + " saved";
        deleteProfileBtn.disabled = !profileSelect.value;
    }

    async function loadProfiles(selectId)
    {
        try
        {
            const res = await fetch("/api/profiles");
            const data = await res.json();
            if (!res.ok || !data.ok)
            {
                return;
            }
            renderProfileOptions(data.profiles || [], selectId || activeProfileId);
        }
        catch (_)
        {
        }
    }

    async function selectProfile(id)
    {
        if (!id)
        {
            setActiveStyle(null, null);
            deleteProfileBtn.disabled = true;
            profileHint.textContent = "Pick a saved style to rewrite new text in your voice — or analyze below to create one.";
            return;
        }

        try
        {
            const res = await fetch("/api/profiles/" + id);
            const data = await res.json();
            if (!res.ok || !data.ok || !data.profile)
            {
                throw new Error(data.error || "Profile not found.");
            }

            setActiveStyle(data.profile.skillMd, data.profile.id);
            deleteProfileBtn.disabled = false;
            profileHint.textContent = 'Active style: "' + data.profile.name + '". Convert text below.';
            skillPreview.textContent = data.profile.skillMd;
            resultZone.classList.remove("hidden");
            resultStatus.textContent = "Loaded";
            resultStatus.className = "badge badge-success";
            convertOutput.classList.add("hidden");
            convertStatus.textContent = "";
            convertZone.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        catch (err)
        {
            showToast(err.message, "error");
        }
    }

    profileSelect.addEventListener("change", () => selectProfile(profileSelect.value));

    deleteProfileBtn.addEventListener("click", async () =>
    {
        const id = profileSelect.value;
        if (!id)
        {
            return;
        }
        if (!window.confirm("Delete this saved style?"))
        {
            return;
        }

        try
        {
            const res = await fetch("/api/profiles/" + id, { method: "DELETE" });
            const data = await res.json();
            if (!res.ok || !data.ok)
            {
                throw new Error(data.error || "Delete failed.");
            }

            if (activeProfileId === id)
            {
                setActiveStyle(null, null);
            }
            await loadProfiles("");
            await selectProfile("");
            showToast("Style profile deleted.", "success");
        }
        catch (err)
        {
            showToast(err.message, "error");
        }
    });

    saveProfileBtn.addEventListener("click", async () =>
    {
        if (!analysisResult)
        {
            showToast("Run an analysis first.", "error");
            return;
        }

        saveProfileBtn.disabled = true;
        try
        {
            const res = await fetch("/api/profiles", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: profileNameInput.value.trim(), skillMd: analysisResult })
            });
            const data = await res.json();
            if (!res.ok || !data.ok)
            {
                throw new Error(data.error || "Save failed.");
            }

            activeProfileId = data.profile.id;
            profileNameInput.value = "";
            await loadProfiles(data.profile.id);
            deleteProfileBtn.disabled = false;
            profileHint.textContent = 'Saved as "' + data.profile.name + '". It will be here next time.';
            showToast('Style saved as "' + data.profile.name + '".', "success");
        }
        catch (err)
        {
            showToast(err.message, "error");
        }
        finally
        {
            saveProfileBtn.disabled = false;
        }
    });

    async function runConvert()
    {
        if (!analysisResult)
        {
            showToast("Select or save a style profile first.", "error");
            return;
        }

        const text = convertInput.value.trim();
        const useUploaded = !text && uploadedFiles.length > 0;
        if (!text && !useUploaded)
        {
            showToast("Paste text or upload a file to convert.", "error");
            return;
        }

        convertBtn.disabled = true;
        convertStatus.textContent = "Converting...";
        convertOutput.classList.add("hidden");

        const body = { targetLanguage: convertLang.value };
        if (activeProfileId)
        {
            body.profileId = activeProfileId;
        }
        else
        {
            body.skillMd = analysisResult;
        }
        if (text)
        {
            body.text = text;
        }
        if (useUploaded)
        {
            body.fileIds = uploadedFiles.map((f) => f.id);
        }

        try
        {
            const res = await fetch("/api/convert", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok || !data.ok)
            {
                throw new Error(data.error || "Conversion failed.");
            }

            convertResult = data.converted;
            convertPreview.textContent = convertResult;
            convertOutput.classList.remove("hidden");
            convertStatus.textContent = "Done.";
            if (data.warning)
            {
                showToast(data.warning, "error");
            }
        }
        catch (err)
        {
            showToast(err.message, "error");
            convertStatus.textContent = "Failed.";
        }
        finally
        {
            convertBtn.disabled = false;
        }
    }

    convertBtn.addEventListener("click", runConvert);

    convertCopyBtn.addEventListener("click", () =>
    {
        if (!convertResult)
        {
            return;
        }
        navigator.clipboard.writeText(convertResult).then(() =>
        {
            showToast("Copied to clipboard!", "success");
        }).catch(() =>
        {
            const ta = document.createElement("textarea");
            ta.value = convertResult;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            showToast("Copied to clipboard!", "success");
        });
    });

    /* ===== Initial State ===== */
    updateAnalyzeButton();
    loadProfiles();
})();
