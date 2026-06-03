/* Parallax PA - app logic (vanilla, no build step) */
(function () {
  "use strict";
  const C = window.PA_CONFIG;
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const $ = (id) => document.getElementById(id);
  const webhook = (key) => C.N8N_WEBHOOK_BASE + C.ENDPOINTS[key];

  let listenDefault = false;

  /* ---------- Tab navigation ---------- */
  function switchTab(tab) {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("tab-" + tab).classList.add("active");
    document.querySelectorAll(".nav-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === tab)
    );
    if (tab === "inbox") loadInbox();
    if (tab === "chat") loadChatHistory();
  }
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );

  /* ---------- Settings ---------- */
  $("settingsBtn").addEventListener("click", () => ($("settingsSheet").hidden = false));
  $("closeSettings").addEventListener("click", () => ($("settingsSheet").hidden = true));
  $("settingsSheet").addEventListener("click", (e) => {
    if (e.target.id === "settingsSheet") $("settingsSheet").hidden = true;
  });
  $("listenDefault").addEventListener("change", async (e) => {
    listenDefault = e.target.checked;
    try { await sb.from("pa_settings").update({ listen_default: listenDefault, updated_at: new Date().toISOString() }).eq("id", 1); } catch (_) {}
  });
  async function loadSettings() {
    try {
      const { data } = await sb.from("pa_settings").select("listen_default").eq("id", 1).single();
      if (data) { listenDefault = !!data.listen_default; $("listenDefault").checked = listenDefault; }
    } catch (_) {}
  }

  /* ---------- Workspace picker ---------- */
  (function fillWorkspaces() {
    const sel = $("workspaceSelect");
    C.WORKSPACES.forEach((w) => {
      const o = document.createElement("option");
      o.value = w.id; o.textContent = w.label; sel.appendChild(o);
    });
  })();

  /* ---------- Voice recording (shared helper) ---------- */
  function makeRecorder(onDone) {
    let mediaRecorder = null, chunks = [];
    async function start() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      chunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        onDone(new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" }));
      };
      mediaRecorder.start();
    }
    function stop() { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); }
    return { start, stop };
  }

  async function transcribe(blob) {
    const fd = new FormData();
    fd.append("audio", blob, "voice.webm");
    const res = await fetch(webhook("transcribe"), { method: "POST", body: fd });
    if (!res.ok) throw new Error("transcribe failed");
    const data = await res.json();
    return data.text || data.transcript || "";
  }

  /* ---------- SEND TASK ---------- */
  const sendRec = makeRecorder(async (blob) => {
    $("recordStatus").textContent = "Transcribing...";
    try {
      const text = await transcribe(blob);
      const ta = $("taskText");
      ta.value = ta.value ? ta.value + " " + text : text;
      $("recordStatus").textContent = "";
    } catch (e) {
      $("recordStatus").textContent = "Voice unavailable (backend not live yet)";
    }
  });
  let sendRecording = false;
  function toggleSendRecord() {
    const btn = $("recordBtn");
    if (!sendRecording) {
      sendRec.start().then(() => {
        sendRecording = true;
        btn.classList.add("recording");
        $("recordLabel").textContent = "Tap to stop";
        $("recordStatus").textContent = "Listening...";
      }).catch(() => ($("recordStatus").textContent = "Mic permission needed"));
    } else {
      sendRec.stop(); sendRecording = false;
      btn.classList.remove("recording");
      $("recordLabel").textContent = "Hold to record";
    }
  }
  $("recordBtn").addEventListener("click", toggleSendRecord);

  $("sendTaskBtn").addEventListener("click", async () => {
    const workspace = $("workspaceSelect").value;
    const task = $("taskText").value.trim();
    const out = $("sendResult");
    if (!task) { out.className = "result-line err"; out.textContent = "Type or record a task first."; return; }
    $("sendTaskBtn").disabled = true;
    out.className = "result-line"; out.textContent = "Sending...";
    try {
      const res = await fetch(webhook("sendTask"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, task, source: sendRecording ? "voice" : "text" }),
      });
      if (!res.ok) throw new Error("send failed");
      out.className = "result-line ok"; out.textContent = "Sent. It'll be picked up shortly.";
      $("taskText").value = "";
      // optimistic local record
      try { await sb.from("pa_tasks").insert({ workspace, task_text: task, source: "text", status: "queued" }); } catch (_) {}
    } catch (e) {
      out.className = "result-line err"; out.textContent = "Backend not live yet - this will work once the n8n workflow is deployed.";
    } finally {
      $("sendTaskBtn").disabled = false;
    }
  });

  /* ---------- CHAT ---------- */
  const chatScroll = $("chatScroll");
  function addBubble(role, text, opts = {}) {
    $("chatEmpty") && ($("chatEmpty").style.display = "none");
    const b = document.createElement("div");
    b.className = "bubble " + role;
    b.textContent = text;
    chatScroll.appendChild(b);
    if (role === "assistant" && !opts.noListen) {
      const row = document.createElement("div");
      row.className = "bubble-actions";
      const lb = document.createElement("button");
      lb.className = "listen-btn"; lb.textContent = "🔊 Listen";
      lb.addEventListener("click", () => speak(text));
      row.appendChild(lb);
      chatScroll.appendChild(row);
    }
    chatScroll.scrollTop = chatScroll.scrollHeight;
    return b;
  }

  async function speak(text) {
    try {
      const res = await fetch(webhook("speak"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("tts failed");
      const blob = await res.blob();
      new Audio(URL.createObjectURL(blob)).play();
    } catch (e) {
      // Fallback to the phone's built-in voice
      if (window.speechSynthesis) {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      }
    }
  }

  async function sendChat(message) {
    if (!message.trim()) return;
    addBubble("user", message);
    $("chatInput").value = "";
    try { await sb.from("pa_messages").insert({ role: "user", content: message }); } catch (_) {}
    const typing = addBubble("assistant", "...", { noListen: true });
    typing.classList.add("typing");
    try {
      const res = await fetch(webhook("chat"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error("chat failed");
      const data = await res.json();
      const reply = data.reply || data.text || "(no reply)";
      typing.remove();
      addBubble("assistant", reply);
      try { await sb.from("pa_messages").insert({ role: "assistant", content: reply }); } catch (_) {}
      if (listenDefault) speak(reply);
    } catch (e) {
      typing.remove();
      addBubble("assistant", "Chat backend isn't live yet - it'll answer once the n8n chat workflow is deployed.");
    }
  }
  $("chatSendBtn").addEventListener("click", () => sendChat($("chatInput").value));
  $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat($("chatInput").value); });
  document.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => sendChat(c.dataset.chip))
  );

  const chatRec = makeRecorder(async (blob) => {
    try { const text = await transcribe(blob); if (text) sendChat(text); } catch (_) {}
  });
  let chatRecording = false;
  $("chatRecordBtn").addEventListener("click", () => {
    const btn = $("chatRecordBtn");
    if (!chatRecording) {
      chatRec.start().then(() => { chatRecording = true; btn.classList.add("recording"); }).catch(() => {});
    } else {
      chatRec.stop(); chatRecording = false; btn.classList.remove("recording");
    }
  });

  let chatLoaded = false;
  async function loadChatHistory() {
    if (chatLoaded) return;
    chatLoaded = true;
    try {
      const { data } = await sb.from("pa_messages").select("role,content").order("created_at", { ascending: true }).limit(40);
      if (data && data.length) data.forEach((m) => addBubble(m.role, m.content, { noListen: m.role === "user" }));
    } catch (_) {}
  }

  /* ---------- INBOX ---------- */
  async function loadInbox() {
    const list = $("inboxList");
    try {
      const { data } = await sb.from("pa_tasks").select("*").order("created_at", { ascending: false }).limit(30);
      if (!data || !data.length) { list.innerHTML = '<div class="inbox-empty">Nothing here yet.</div>'; return; }
      list.innerHTML = "";
      data.forEach((t) => {
        const card = document.createElement("div");
        card.className = "inbox-card";
        const ws = (C.WORKSPACES.find((w) => w.id === t.workspace) || {}).label || t.workspace;
        card.innerHTML =
          '<div class="ws">' + ws + '</div>' +
          '<div class="txt">' + escapeHtml(t.task_text) + '</div>' +
          '<div class="meta"><span>' + new Date(t.created_at).toLocaleString() + '</span>' +
          '<span class="status-pill ' + t.status + '">' + t.status.replace("_", " ") + '</span></div>';
        list.appendChild(card);
      });
      const open = data.filter((t) => t.status === "queued" || t.status === "picked_up").length;
      const badge = $("inboxBadge");
      if (open > 0) { badge.hidden = false; badge.textContent = open; } else { badge.hidden = true; }
    } catch (e) {
      list.innerHTML = '<div class="inbox-empty">Could not load - check connection.</div>';
    }
  }
  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  /* ---------- Service worker ---------- */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  /* ---------- Init ---------- */
  loadSettings();
})();
