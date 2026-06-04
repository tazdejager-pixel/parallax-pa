/* Parallax PA - app logic (vanilla, no build step) */
(function () {
  "use strict";
  const C = window.PA_CONFIG;
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const $ = (id) => document.getElementById(id);
  const webhook = (key) => C.N8N_WEBHOOK_BASE + C.ENDPOINTS[key];

  let listenDefault = false;

  /* ---------- Auth (single user - Tarryn) ---------- */
  let session = null;
  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (session) h["Authorization"] = "Bearer " + session.access_token;
    return h;
  }
  function updateAuthUI() {
    $("loginScreen").hidden = !!session;
    $("signedInAs").textContent = session ? "Signed in as " + session.user.email : "";
  }
  sb.auth.onAuthStateChange((_event, s) => { session = s; updateAuthUI(); });
  async function initAuth() {
    const { data } = await sb.auth.getSession();
    session = data.session;
    updateAuthUI();
    if (session) loadSettings();
  }
  async function doLogin() {
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    const err = $("loginError");
    if (!email || !password) { err.textContent = "Enter your email and password."; return; }
    $("loginBtn").disabled = true;
    err.textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email, password });
    $("loginBtn").disabled = false;
    if (error) { err.textContent = "Sign-in failed - check email and password."; return; }
    $("loginPassword").value = "";
    loadSettings();
  }
  $("loginBtn").addEventListener("click", doLogin);
  $("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("signOutBtn").addEventListener("click", async () => {
    await sb.auth.signOut();
    $("settingsSheet").hidden = true;
  });

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
    syncPushUI();
  }

  /* ---------- Push notifications (Slice 4) ---------- */
  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }
  function urlB64ToUint8Array(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function getSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function saveSubscription(sub) {
    const j = sub.toJSON();
    await sb.from("pa_push_subscriptions").upsert(
      { endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth },
      { onConflict: "endpoint" });
  }
  async function enablePush() {
    const note = $("pushNote");
    if (!pushSupported()) {
      note.textContent = "This phone/browser can't do app notifications. On iPhone, add the app to your Home Screen first, then try again.";
      return false;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      note.textContent = "Notifications are blocked. Allow them for this app in your phone settings, then flip this switch again.";
      return false;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(C.VAPID_PUBLIC_KEY),
        }));
      await saveSubscription(sub);
      note.textContent = "Notifications are on for this phone.";
      return true;
    } catch (e) {
      note.textContent = "Couldn't switch notifications on - try again.";
      return false;
    }
  }
  async function disablePush() {
    try {
      const sub = await getSubscription();
      if (sub) {
        await sb.from("pa_push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
    } catch (_) {}
    $("pushNote").textContent = "Get a notification when Claude needs a decision or finishes a task.";
  }
  async function syncPushUI() {
    try {
      const on = pushSupported() && Notification.permission === "granted" && !!(await getSubscription());
      $("pushToggle").checked = on;
      if (on && session) {
        // keep the saved address fresh (endpoints can rotate)
        const sub = await getSubscription();
        if (sub) saveSubscription(sub);
      }
    } catch (_) {}
  }
  $("pushToggle").addEventListener("change", async (e) => {
    if (e.target.checked) {
      const ok = await enablePush();
      if (!ok) e.target.checked = false;
    } else {
      await disablePush();
    }
  });

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
    const res = await fetch(webhook("transcribe"), { method: "POST", headers: authHeaders(), body: fd });
    if (!res.ok) throw new Error("transcribe failed");
    const data = await res.json();
    return data.text || data.transcript || "";
  }

  /* ---------- SEND TASK ---------- */
  let taskHasVoice = false;
  const sendRec = makeRecorder(async (blob) => {
    $("recordStatus").textContent = "Transcribing...";
    try {
      const text = await transcribe(blob);
      const ta = $("taskText");
      ta.value = ta.value ? ta.value + " " + text : text;
      if (text) taskHasVoice = true;
      $("recordStatus").textContent = "";
    } catch (e) {
      $("recordStatus").textContent = "Voice didn't come through - try again.";
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

  /* ---------- Attachments (Slice 1b) ---------- */
  const ATT_BUCKET = "pa-attachments";
  const ATT_MAX_FILES = 10;
  const ATT_MAX_BYTES = 25 * 1024 * 1024; // matches the bucket's server-side cap
  let taskAttachments = []; // { path, name, type, size }
  let taskDraftId = null;   // uuid folder key, new per task
  let uploadsInFlight = 0;

  function renderAttachChips() {
    const wrap = $("attachChips");
    wrap.innerHTML = "";
    taskAttachments.forEach((a) => {
      const chip = document.createElement("div");
      chip.className = "att-chip";
      const icon = document.createElement("span");
      icon.textContent = (a.type || "").startsWith("image/") ? "\u{1F5BC}" : "\u{1F4C4}";
      const label = document.createElement("span");
      label.className = "att-name";
      label.textContent = a.name;
      const x = document.createElement("button");
      x.className = "att-remove";
      x.setAttribute("aria-label", "Remove " + a.name);
      x.textContent = "✕";
      x.addEventListener("click", async () => {
        taskAttachments = taskAttachments.filter((t) => t.path !== a.path);
        renderAttachChips();
        try { await sb.storage.from(ATT_BUCKET).remove([a.path]); } catch (_) {}
      });
      chip.appendChild(icon); chip.appendChild(label); chip.appendChild(x);
      wrap.appendChild(chip);
    });
  }

  $("attachBtn").addEventListener("click", () => {
    const st = $("attachStatus");
    if (!session) { st.textContent = "Sign in first."; return; }
    st.textContent = "";
    $("attachInput").click();
  });

  $("attachInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // allow re-picking the same file
    const st = $("attachStatus");
    for (const file of files) {
      if (taskAttachments.length >= ATT_MAX_FILES) { st.textContent = "Max " + ATT_MAX_FILES + " files per task."; break; }
      if (file.size > ATT_MAX_BYTES) { st.textContent = file.name + " is over 25 MB - skipped."; continue; }
      if (!taskDraftId) taskDraftId = crypto.randomUUID();
      // safe storage key: keep letters/digits/dot/dash/underscore
      let name = (file.name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 100) || "file";
      let n = 1;
      while (taskAttachments.some((a) => a.name === name)) name = (n++) + "-" + name;
      const path = "tasks/" + taskDraftId + "/" + name;
      uploadsInFlight++;
      st.textContent = "Uploading " + name + "...";
      try {
        const { error } = await sb.storage.from(ATT_BUCKET)
          .upload(path, file, { contentType: file.type || "application/octet-stream" });
        if (error) throw error;
        taskAttachments.push({ path, name, type: file.type || "application/octet-stream", size: file.size });
        renderAttachChips();
        st.textContent = "";
      } catch (err) {
        st.textContent = "Couldn't upload " + name + " - try again.";
      } finally {
        uploadsInFlight--;
      }
    }
  });

  /* ---------- Tidy up (Slice 5: voice memo -> structured task + suggested workspace) ---------- */
  $("tidyBtn").addEventListener("click", async () => {
    const st = $("tidyStatus");
    const ta = $("taskText");
    const text = ta.value.trim();
    if (!session) { st.textContent = "Sign in first."; return; }
    if (!text) { st.textContent = "Nothing to tidy yet - speak or type first."; return; }
    $("tidyBtn").disabled = true;
    st.textContent = "Tidying...";
    try {
      const res = await fetch(webhook("structure"), {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("structure failed");
      const data = await res.json();
      if (data.task) ta.value = data.task;
      // Suggest the workspace when she left the picker on Auto
      if (data.workspace && $("workspaceSelect").value === "auto") {
        $("workspaceSelect").value = data.workspace;
        const label = (C.WORKSPACES.find((w) => w.id === data.workspace) || {}).label || data.workspace;
        st.textContent = "Tidied - I'd send this to " + label + ". Change it if I'm wrong.";
      } else {
        st.textContent = "Tidied - check it reads right.";
      }
    } catch (e) {
      st.textContent = "Couldn't tidy that - you can still send it as-is.";
    } finally {
      $("tidyBtn").disabled = false;
    }
  });

  $("sendTaskBtn").addEventListener("click", async () => {
    const workspace = $("workspaceSelect").value;
    const task = $("taskText").value.trim();
    const out = $("sendResult");
    if (!task) { out.className = "result-line err"; out.textContent = "Type or record a task first."; return; }
    if (uploadsInFlight > 0) { out.className = "result-line err"; out.textContent = "Wait a moment - a file is still uploading."; return; }
    $("sendTaskBtn").disabled = true;
    out.className = "result-line"; out.textContent = "Sending...";
    try {
      const res = await fetch(webhook("sendTask"), {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ workspace, task, source: taskHasVoice ? "voice" : "text", attachments: taskAttachments }),
      });
      if (!res.ok) throw new Error("send failed");
      out.className = "result-line ok"; out.textContent = "Sent. It'll be picked up within the hour.";
      $("taskText").value = "";
      taskHasVoice = false;
      taskAttachments = []; taskDraftId = null; renderAttachChips();
      // the workflow records the task server-side; refresh the inbox badge
      loadInbox();
    } catch (e) {
      out.className = "result-line err";
      out.textContent = session ? "Couldn't send - check your connection and try again." : "Please sign in first.";
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
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
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
    // history is stored server-side by the PA - Chat workflow (both roles)
    const typing = addBubble("assistant", "...", { noListen: true });
    typing.classList.add("typing");
    try {
      const res = await fetch(webhook("chat"), {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error("chat failed");
      const data = await res.json();
      const reply = data.reply || data.text || "(no reply)";
      typing.remove();
      addBubble("assistant", reply);
      if (listenDefault) speak(reply);
    } catch (e) {
      typing.remove();
      addBubble("assistant", "Chat backend isn't live yet - it'll answer once the n8n chat workflow is deployed.");
    }
  }
  $("chatSendBtn").addEventListener("click", () => sendChat($("chatInput").value));
  $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat($("chatInput").value); });
  document.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () =>
      c.dataset.chip === "__brief" ? morningBrief() : sendChat(c.dataset.chip))
  );

  /* ---------- Morning brief (Slice 5) - fetched server-side, spoken aloud ---------- */
  let briefRunning = false;
  async function morningBrief() {
    if (briefRunning) return;
    briefRunning = true;
    addBubble("user", "Morning brief, please");
    const typing = addBubble("assistant", "Pulling your brief together...", { noListen: true });
    typing.classList.add("typing");
    try {
      const res = await fetch(webhook("brief"), {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: "{}",
      });
      if (!res.ok) throw new Error("brief failed");
      const data = await res.json();
      const brief = data.brief || "I couldn't put a brief together just now - try again in a minute.";
      typing.remove();
      addBubble("assistant", brief);
      speak(brief); // the point of the brief is hearing it - always spoken
    } catch (e) {
      typing.remove();
      addBubble("assistant", "I couldn't fetch your brief - check your connection and try again.");
    } finally {
      briefRunning = false;
    }
  }

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
        const attCount = Array.isArray(t.attachments) ? t.attachments.length : 0;
        const attIcon = attCount ? '<span class="att-count">&#128206;' + attCount + '</span>' : '';
        card.innerHTML =
          '<div class="ws">' + ws + '</div>' +
          '<div class="txt">' + escapeHtml(t.task_text) + '</div>' +
          '<div class="meta"><span>' + new Date(t.created_at).toLocaleString() + attIcon + '</span>' +
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
  initAuth();
})();
